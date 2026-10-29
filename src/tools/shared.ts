/**
 * Shared plumbing for tools: auth extraction, account resolution, query
 * execution, argument schemas, and error messages with actionable hints.
 */
import * as z from 'zod';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { normalizeCustomerId, type Config } from '../config.js';
import type { GoogleAuthExtra } from '../auth/provider.js';
import { GoogleAdsApiError, type AdsAuth, type GoogleAdsClient, type Row, type SearchResult } from '../ads/client.js';
import { DATE_PRESETS, DateRangeError, resolveDateRange, type DateRange, type DateRangeInput } from '../ads/dates.js';
import { dashed } from '../ads/format.js';
import { gaql, ORDER_KEYS, Q, STATUS_FILTERS, type GaqlSpec } from '../ads/queries.js';

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface ToolContext {
  cfg: Config;
  ads: GoogleAdsClient;
  log: (message: string) => void;
}

export type ToolRegistrar = (server: McpServer, ctx: ToolContext) => void;

/** Problems the caller can fix by changing the arguments. */
export class ToolInputError extends Error {}

export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// ------------------------------------------------------------------ schemas

export const customerArgs = {
  customer_id: z
    .string()
    .optional()
    .describe('Google Ads account ID, e.g. 123-456-7890. Defaults to the server default, or to your only account.'),
  login_customer_id: z
    .string()
    .optional()
    .describe('Manager (MCC) account ID to access customer_id through, if list_accounts shows one. Usually leave empty.'),
};

export const dateArgs = {
  date_range: z
    .enum(DATE_PRESETS)
    .optional()
    .describe('Preset period in the account time zone (default last_30_days). last_N_days ranges end yesterday.'),
  start_date: z.string().optional().describe('Custom period start, YYYY-MM-DD. Use with end_date instead of date_range.'),
  end_date: z.string().optional().describe('Custom period end, YYYY-MM-DD, inclusive.'),
};

export const idFilter = (what: string) =>
  z
    .string()
    .regex(/^\d{1,20}$/, 'Use the numeric ID')
    .optional()
    .describe(`Only this ${what} (numeric ID, as returned by other tools).`);

export const limitArg = (fallback: number, max: number) =>
  z.number().int().min(1).max(max).default(fallback).describe(`Maximum rows to return (default ${fallback}, max ${max}).`);

export const orderArg = z.enum(ORDER_KEYS).default('cost').describe('Sort by this metric, highest first (default cost).');

export const statusArg = z
  .enum(STATUS_FILTERS)
  .default('active')
  .describe('active = enabled or paused (default), enabled, paused, or all including removed.');

// ------------------------------------------------------------------ results

export const ok = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

const fail = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

function hintsFor(error: GoogleAdsApiError): string[] {
  const hints: string[] = [];
  if (error.httpStatus === 401) {
    hints.push('Google rejected the sign-in token. Disconnect and reconnect this connector in Claude.');
  }
  if (error.hasCode('USER_PERMISSION_DENIED')) {
    hints.push(
      'The signed-in Google account cannot reach this customer ID through the login customer ID used. ' +
        'Run list_accounts and pass the login_customer_id it shows for this account.',
    );
  }
  if (error.hasCode('DEVELOPER_TOKEN') || /test accounts/i.test(error.message) || error.hasCode('NOT_ALLOWLISTED')) {
    hints.push(
      "The Google Cloud project behind this server's OAuth client lacks production Google Ads API access " +
        '(test-account access only). Apply for Explorer or Basic access in the Google Ads API page of that Cloud project.',
    );
  }
  if (error.hasCode('CUSTOMER_NOT_ENABLED')) hints.push('This account is cancelled or not fully set up.');
  if (error.hasCode('REQUESTED_METRICS_FOR_MANAGER')) {
    hints.push('This is a manager account, which has no metrics of its own. Pick a client account from list_accounts.');
  }
  if (error.hasCode('queryError') || error.hasCode('QUERY_ERROR') || error.hasCode('requestError')) {
    hints.push('Check field names and compatibility with describe_resource before retrying.');
  }
  if (error.httpStatus === 429 || error.status === 'RESOURCE_EXHAUSTED') {
    hints.push('Google Ads API quota reached (Explorer access has a daily operations cap). Try again later or narrow the request.');
  }
  return hints;
}

export function describeError(error: unknown): string {
  if (error instanceof ToolInputError || error instanceof DateRangeError) return error.message;
  if (error instanceof GoogleAdsApiError) {
    const head = `Google Ads API error${error.status ? ` (${error.status})` : ''}: ${error.message}`;
    const tail = error.requestId ? ` [request ${error.requestId}]` : '';
    const hints = hintsFor(error);
    return [head + tail, ...hints.map((h) => `Hint: ${h}`)].join('\n');
  }
  return `Unexpected error: ${(error as Error)?.message ?? String(error)}`;
}

/** Wraps a tool body with error handling and one log line per call. */
export async function runTool(
  ctx: ToolContext,
  name: string,
  extra: Extra,
  body: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const started = Date.now();
  const who = (extra.authInfo?.extra as GoogleAuthExtra | undefined)?.email ?? 'unknown';
  try {
    const result = await body();
    ctx.log(`tool ${name} by ${who} ok ${Date.now() - started}ms`);
    return result;
  } catch (error) {
    const message = describeError(error);
    ctx.log(`tool ${name} by ${who} failed ${Date.now() - started}ms: ${message.split('\n')[0]}`);
    return fail(message);
  }
}

// ------------------------------------------------------------------ session

export function authFrom(extra: Extra): AdsAuth {
  const info = extra.authInfo?.extra as GoogleAuthExtra | undefined;
  if (!info?.googleAccessToken) throw new ToolInputError('Not signed in. Reconnect this connector in Claude.');
  return { accessToken: info.googleAccessToken, email: info.email };
}

export interface AccountInfo {
  id: string;
  name: string;
  currency: string;
  timeZone: string;
  manager: boolean;
  testAccount: boolean;
  status: string;
}

const ACCOUNT_CACHE_MS = 10 * 60 * 1000;
const accountCache = new Map<string, { info: AccountInfo; expires: number }>();

export class AdsSession {
  private loginCustomerId: string | undefined;

  constructor(
    readonly ctx: ToolContext,
    readonly auth: AdsAuth,
    readonly customerId: string,
    loginCustomerId: string | undefined,
    private readonly loginExplicit: boolean,
  ) {
    this.loginCustomerId = loginCustomerId;
  }

  get login(): string | undefined {
    return this.loginCustomerId;
  }

  async search(query: string, maxRows?: number): Promise<SearchResult> {
    try {
      return await this.ctx.ads.search(this.auth, this.customerId, query, { loginCustomerId: this.loginCustomerId, maxRows });
    } catch (error) {
      // The configured default manager may not cover this account; try direct access once.
      if (
        error instanceof GoogleAdsApiError &&
        error.hasCode('USER_PERMISSION_DENIED') &&
        this.loginCustomerId &&
        !this.loginExplicit &&
        this.loginCustomerId !== this.customerId
      ) {
        const result = await this.ctx.ads.search(this.auth, this.customerId, query, { maxRows });
        this.loginCustomerId = undefined;
        return result;
      }
      throw error;
    }
  }

  /** Runs a query capped at `limit` rows and reports whether more existed. */
  async rows(spec: GaqlSpec, limit?: number): Promise<{ rows: Row[]; truncated: boolean }> {
    if (!limit) return this.search(gaql(spec));
    const result = await this.search(gaql({ ...spec, limit: limit + 1 }), limit + 1);
    return { rows: result.rows.slice(0, limit), truncated: result.truncated || result.rows.length > limit };
  }

  async account(): Promise<AccountInfo> {
    const key = `${this.auth.email}|${this.customerId}`;
    const cached = accountCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.info;
    const { rows } = await this.search(gaql(Q.customerBasics()));
    const c = (rows[0]?.customer ?? {}) as Row;
    const info: AccountInfo = {
      id: String(c.id ?? this.customerId),
      name: String(c.descriptiveName ?? ''),
      currency: String(c.currencyCode ?? ''),
      timeZone: String(c.timeZone ?? 'UTC'),
      manager: c.manager === true,
      testAccount: c.testAccount === true,
      status: String(c.status ?? ''),
    };
    accountCache.set(key, { info, expires: Date.now() + ACCOUNT_CACHE_MS });
    if (accountCache.size > 500) accountCache.delete(accountCache.keys().next().value!);
    return info;
  }

  /** Account info, refusing manager accounts (they have no metrics of their own). */
  async clientAccount(): Promise<AccountInfo> {
    const info = await this.account();
    if (info.manager) {
      throw new ToolInputError(
        `${dashed(info.id)} (${info.name}) is a manager account, which has no performance data of its own. ` +
          'Run list_accounts and pass one of its client accounts as customer_id.',
      );
    }
    return info;
  }

  range(input: DateRangeInput, account: AccountInfo): DateRange {
    return resolveDateRange(input, account.timeZone);
  }

  /** Context block included at the top of every report. */
  header(account: AccountInfo, range?: DateRange): Record<string, unknown> {
    return {
      customer_id: dashed(account.id),
      account: account.name,
      currency: account.currency,
      ...(range ? { date_range: { start: range.start, end: range.end, label: range.label, days: range.days } } : {}),
    };
  }
}

export async function openSession(
  ctx: ToolContext,
  extra: Extra,
  args: { customer_id?: string; login_customer_id?: string },
): Promise<AdsSession> {
  const auth = authFrom(extra);
  let customerId: string | undefined;
  if (args.customer_id) {
    customerId = normalizeCustomerId(args.customer_id) ?? undefined;
    if (!customerId) throw new ToolInputError('customer_id must be a 10-digit Google Ads ID, e.g. 123-456-7890.');
  } else {
    customerId = ctx.cfg.ads.defaultCustomerId;
  }
  if (!customerId) {
    const ids = await ctx.ads.listAccessibleCustomers(auth);
    if (ids.length === 1) customerId = ids[0]!;
    else if (ids.length === 0) throw new ToolInputError('This Google account cannot access any Google Ads accounts.');
    else {
      throw new ToolInputError(
        `No customer_id given. This Google account directly accesses ${ids.length} accounts ` +
          `(${ids.slice(0, 10).map(dashed).join(', ')}${ids.length > 10 ? ', ...' : ''}). ` +
          'Run list_accounts to see names and client accounts, then pass customer_id.',
      );
    }
  }
  let login: string | undefined;
  if (args.login_customer_id) {
    login = normalizeCustomerId(args.login_customer_id) ?? undefined;
    if (!login) throw new ToolInputError('login_customer_id must be a 10-digit Google Ads ID.');
  } else {
    login = ctx.cfg.ads.loginCustomerId;
  }
  return new AdsSession(ctx, auth, customerId, login, Boolean(args.login_customer_id));
}

/** Runs `fn` over `items` with at most `limit` calls in flight. */
export async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

/** Joins enum lists like primary_status_reasons into one readable cell. */
export const joinList = (value: unknown): string | null =>
  Array.isArray(value) && value.length ? value.map(String).join(', ') : null;
