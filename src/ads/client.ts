/**
 * Read-only Google Ads API client (REST).
 *
 * Only these endpoints exist here, all of them non-mutating:
 *   customers:listAccessibleCustomers, customers/{id}/googleAds:search,
 *   googleAdsFields:search, customers/{id}:generateKeywordIdeas,
 *   geoTargetConstants:suggest
 * There is deliberately no code path that can call a mutate endpoint.
 */
import type { Config } from '../config.js';

/** REST rows are nested JSON objects keyed by camelCase field names. */
export type Row = Record<string, any>;

export interface AdsAuth {
  accessToken: string;
  email: string;
}

export interface AdsErrorDetail {
  code: string;
  message: string;
  trigger?: string;
}

export class GoogleAdsApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly status?: string,
    readonly requestId?: string,
    readonly errors: AdsErrorDetail[] = [],
  ) {
    super(message);
  }

  hasCode(fragment: string): boolean {
    return this.errors.some((e) => e.code.includes(fragment)) || this.message.includes(fragment);
  }
}

export interface SearchOptions {
  loginCustomerId?: string;
  /** Stop reading after this many rows; `truncated` reports whether more existed. */
  maxRows?: number;
}

export interface SearchResult {
  rows: Row[];
  truncated: boolean;
}

const TRANSIENT = new Set([429, 500, 502, 503, 504]);

export class GoogleAdsClient {
  constructor(
    private readonly cfg: Config['ads'],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get apiVersion(): string {
    return this.cfg.apiVersion;
  }

  async listAccessibleCustomers(auth: AdsAuth): Promise<string[]> {
    const body = await this.call('GET', 'customers:listAccessibleCustomers', auth);
    return ((body.resourceNames as string[] | undefined) ?? []).map((name) => name.split('/')[1]!).filter(Boolean);
  }

  async search(auth: AdsAuth, customerId: string, query: string, opts: SearchOptions = {}): Promise<SearchResult> {
    const maxRows = opts.maxRows ?? this.cfg.maxRows;
    const rows: Row[] = [];
    let pageToken: string | undefined;
    do {
      const body = await this.call(
        'POST',
        `customers/${customerId}/googleAds:search`,
        auth,
        pageToken ? { query, pageToken } : { query },
        opts.loginCustomerId,
      );
      const results = (body.results as Row[] | undefined) ?? [];
      for (const row of results) {
        if (rows.length >= maxRows) return { rows, truncated: true };
        rows.push(row);
      }
      pageToken = typeof body.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : undefined;
      if (pageToken && rows.length >= maxRows) return { rows, truncated: true };
    } while (pageToken);
    return { rows, truncated: false };
  }

  /** GoogleAdsFieldService: GAQL metadata (no customer ID needed). */
  async searchFields(auth: AdsAuth, query: string): Promise<Row[]> {
    const body = await this.call('POST', 'googleAdsFields:search', auth, { query, pageSize: 10000 });
    return (body.results as Row[] | undefined) ?? [];
  }

  async generateKeywordIdeas(auth: AdsAuth, customerId: string, request: Row, loginCustomerId?: string): Promise<Row> {
    return this.call('POST', `customers/${customerId}:generateKeywordIdeas`, auth, request, loginCustomerId);
  }

  async suggestGeoTargets(auth: AdsAuth, request: Row): Promise<Row> {
    return this.call('POST', 'geoTargetConstants:suggest', auth, request);
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    auth: AdsAuth,
    body?: Row,
    loginCustomerId?: string,
  ): Promise<Row> {
    const url = `${this.cfg.baseUrl}/${this.cfg.apiVersion}/${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${auth.accessToken}`,
      accept: 'application/json',
    };
    if (body) headers['content-type'] = 'application/json';
    // Since 2026-09-09 Google ignores this header (access comes from the Cloud
    // project), but sending it is harmless for setups that still have one.
    if (this.cfg.developerToken) headers['developer-token'] = this.cfg.developerToken;
    if (loginCustomerId) headers['login-customer-id'] = loginCustomerId;

    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        if (attempt < 2) {
          await delay(750);
          continue;
        }
        throw new GoogleAdsApiError(`Could not reach the Google Ads API: ${(error as Error).message}`, 503, 'UNAVAILABLE');
      }
      if (response.ok) return (await response.json()) as Row;
      if (TRANSIENT.has(response.status) && attempt < 2) {
        await delay(response.status === 429 ? 2000 : 750);
        continue;
      }
      throw await parseError(response, this.cfg.apiVersion);
    }
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function parseError(response: Response, apiVersion: string): Promise<GoogleAdsApiError> {
  const text = await response.text().catch(() => '');
  let json: Row | undefined;
  try {
    json = JSON.parse(text) as Row;
  } catch {
    json = undefined;
  }
  const error = (Array.isArray(json) ? json[0]?.error : json?.error) as Row | undefined;
  if (!error) {
    const hint =
      response.status === 404
        ? ` (API version ${apiVersion} may be retired; set GOOGLE_ADS_API_VERSION to a current version)`
        : '';
    return new GoogleAdsApiError(`Google Ads API HTTP ${response.status}${hint}: ${text.slice(0, 300)}`, response.status);
  }
  const failure = ((error.details as Row[] | undefined) ?? []).find((d) => String(d['@type'] ?? '').includes('GoogleAdsFailure'));
  const errors: AdsErrorDetail[] = ((failure?.errors as Row[] | undefined) ?? []).map((e) => ({
    code: Object.entries((e.errorCode as Row | undefined) ?? {})
      .map(([kind, value]) => `${kind}.${value}`)
      .join(','),
    message: String(e.message ?? ''),
    trigger: e.trigger ? String(Object.values(e.trigger as Row)[0] ?? '') : undefined,
  }));
  const summary = errors.length
    ? errors.map((e) => `${e.code}: ${e.message}${e.trigger ? ` (value: ${e.trigger})` : ''}`).join('; ')
    : String(error.message ?? `HTTP ${response.status}`);
  return new GoogleAdsApiError(
    summary,
    response.status,
    typeof error.status === 'string' ? error.status : undefined,
    typeof failure?.requestId === 'string' ? failure.requestId : undefined,
    errors,
  );
}
