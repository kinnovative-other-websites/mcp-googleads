import * as z from 'zod';
import { gaql, Q } from '../ads/queries.js';
import { previousPeriod } from '../ads/dates.js';
import {
  addMetrics,
  changePct,
  dashed,
  derive,
  emptyMetrics,
  METRIC_COLUMNS,
  METRIC_NOTE,
  metricCells,
  num,
  percent,
  readMetrics,
  round,
  type BaseMetrics,
} from '../ads/format.js';
import type { Row } from '../ads/client.js';
import {
  authFrom,
  customerArgs,
  dateArgs,
  describeError,
  idFilter,
  mapLimit,
  ok,
  openSession,
  READ_ONLY,
  runTool,
  type ToolRegistrar,
} from './shared.js';

const sumRows = (rows: Row[]): BaseMetrics => rows.reduce<BaseMetrics>((acc, r) => addMetrics(acc, readMetrics(r)), emptyMetrics());

export const registerAccountTools: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    'list_accounts',
    {
      title: 'List Google Ads accounts',
      description:
        'Lists every Google Ads account the signed-in Google user can reach, including client accounts under manager (MCC) ' +
        'accounts, with the customer_id and login_customer_id to pass to the other tools. Call this first when the account to use is unclear.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async (_args, extra) =>
      runTool(ctx, 'list_accounts', extra, async () => {
        const auth = authFrom(extra);
        const roots = await ctx.ads.listAccessibleCustomers(auth);
        const accounts = new Map<string, { level: number; record: Record<string, unknown> }>();
        const errors: string[] = [];
        await mapLimit(roots.slice(0, 50), 5, async (root) => {
          try {
            const { rows } = await ctx.ads.search(auth, root, gaql(Q.customerClients()), { loginCustomerId: root, maxRows: 1000 });
            for (const row of rows) {
              const c = (row.customerClient ?? {}) as Row;
              const id = String(c.id ?? '');
              const level = num(c.level);
              const existing = accounts.get(id);
              if (!id || (existing && existing.level <= level)) continue;
              accounts.set(id, {
                level,
                record: {
                  customer_id: dashed(id),
                  name: c.descriptiveName ?? null,
                  manager: c.manager === true,
                  status: c.status ?? null,
                  currency: c.currencyCode ?? null,
                  time_zone: c.timeZone ?? null,
                  test_account: c.testAccount === true,
                  hidden: c.hidden === true,
                  login_customer_id: level === 0 ? null : dashed(root),
                },
              });
            }
          } catch (error) {
            errors.push(`${dashed(root)}: ${describeError(error).split('\n')[0]}`);
          }
        });
        const list = [...accounts.values()]
          .map((a) => a.record)
          .sort((a, b) => Number(a.manager) - Number(b.manager) || String(a.name ?? '').localeCompare(String(b.name ?? '')));
        const columns = ['customer_id', 'name', 'manager', 'status', 'currency', 'time_zone', 'test_account', 'hidden', 'login_customer_id'];
        return ok({
          signed_in_as: auth.email,
          defaults: {
            customer_id: ctx.cfg.ads.defaultCustomerId ? dashed(ctx.cfg.ads.defaultCustomerId) : null,
            login_customer_id: ctx.cfg.ads.loginCustomerId ? dashed(ctx.cfg.ads.loginCustomerId) : null,
          },
          columns,
          rows: list.map((r) => columns.map((c) => r[c] ?? null)),
          notes: [
            'Pass customer_id to other tools. When login_customer_id is set for an account, pass it too.',
            'Manager accounts have no performance data of their own; use their client accounts.',
          ],
          ...(errors.length ? { errors } : {}),
        });
      }),
  );

  server.registerTool(
    'get_account_overview',
    {
      title: 'Account overview',
      description:
        'Headline numbers for one account over a period: impressions, clicks, cost, conversions, value, CTR, CPC, CPA, ROAS, ' +
        'with % change versus the previous period of equal length, plus optimization score and campaign counts. Start most analyses here.',
      inputSchema: {
        ...customerArgs,
        ...dateArgs,
        compare: z.boolean().default(true).describe('Include the previous period and % changes (default true).'),
      },
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      runTool(ctx, 'get_account_overview', extra, async () => {
        const s = await openSession(ctx, extra, args);
        const account = await s.clientAccount();
        const range = s.range(args, account);
        const prevRange = previousPeriod(range);
        const [current, previous, settings, inventory] = await Promise.all([
          s.rows(Q.accountTotals(range)),
          args.compare ? s.rows(Q.accountTotals(prevRange)) : Promise.resolve(null),
          s.rows(Q.customerSettings()).catch(() => null),
          s.rows(Q.campaignInventory()).catch(() => null),
        ]);
        const cur = sumRows(current.rows);
        const allConversions = round(current.rows.reduce((t, r) => t + num(r.metrics?.allConversions), 0), 2);
        const curDerived = derive(cur);
        const block = (m: BaseMetrics) => ({ ...m, ...derive(m) });

        let comparison: Record<string, unknown> | undefined;
        if (previous) {
          const prev = sumRows(previous.rows);
          const prevDerived = derive(prev);
          const pctOrNull = (a: number | null, b: number | null) => (a === null || b === null ? null : changePct(a, b));
          comparison = {
            previous_period: { start: prevRange.start, end: prevRange.end, ...block(prev) },
            change_pct: {
              impressions: changePct(cur.impressions, prev.impressions),
              clicks: changePct(cur.clicks, prev.clicks),
              cost: changePct(cur.cost, prev.cost),
              conversions: changePct(cur.conversions, prev.conversions),
              conv_value: changePct(cur.conv_value, prev.conv_value),
              ctr: pctOrNull(curDerived.ctr, prevDerived.ctr),
              avg_cpc: pctOrNull(curDerived.avg_cpc, prevDerived.avg_cpc),
              cpa: pctOrNull(curDerived.cpa, prevDerived.cpa),
              roas: pctOrNull(curDerived.roas, prevDerived.roas),
            },
          };
        }

        let campaigns: Record<string, unknown> | undefined;
        if (inventory) {
          const byChannel: Record<string, { enabled: number; paused: number }> = {};
          let enabled = 0;
          let paused = 0;
          for (const row of inventory.rows) {
            const status = String(row.campaign?.status ?? '');
            const channel = String(row.campaign?.advertisingChannelType ?? 'UNKNOWN');
            byChannel[channel] ??= { enabled: 0, paused: 0 };
            if (status === 'ENABLED') {
              enabled++;
              byChannel[channel].enabled++;
            } else if (status === 'PAUSED') {
              paused++;
              byChannel[channel].paused++;
            }
          }
          campaigns = { enabled, paused, by_channel: byChannel };
        }

        const customer = (settings?.rows[0]?.customer ?? {}) as Row;
        return ok({
          ...s.header(account, range),
          time_zone: account.timeZone,
          account_status: account.status,
          test_account: account.testAccount,
          optimization_score_pct: percent(customer.optimizationScore),
          auto_tagging_enabled: customer.autoTaggingEnabled ?? null,
          campaigns,
          current: { ...block(cur), all_conversions: allConversions },
          ...comparison,
          notes: [METRIC_NOTE, 'change_pct is null when the previous value was zero.'],
        });
      }),
  );

  server.registerTool(
    'get_performance_trend',
    {
      title: 'Performance trend',
      description:
        'Time series of impressions, clicks, cost, conversions and efficiency by day, week or month, for the whole account ' +
        'or one campaign. Use it to spot when a change in spend or results started.',
      inputSchema: {
        ...customerArgs,
        ...dateArgs,
        granularity: z.enum(['day', 'week', 'month']).default('day').describe('Bucket size (default day). Weeks start on Monday.'),
        campaign_id: idFilter('campaign'),
      },
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      runTool(ctx, 'get_performance_trend', extra, async () => {
        const s = await openSession(ctx, extra, args);
        const account = await s.clientAccount();
        const range = s.range(args, account);
        const { rows } = await s.rows(Q.trend(range, args.granularity, args.campaign_id));
        const buckets = new Map<string, BaseMetrics>();
        const key = args.granularity === 'day' ? 'date' : args.granularity;
        for (const row of rows) {
          const period = String(row.segments?.[key] ?? '');
          addMetrics(buckets.get(period) ?? buckets.set(period, emptyMetrics()).get(period)!, readMetrics(row));
        }
        const periods = [...buckets.keys()].sort();
        return ok({
          ...s.header(account, range),
          granularity: args.granularity,
          campaign_id: args.campaign_id ?? null,
          columns: ['period', ...METRIC_COLUMNS],
          rows: periods.map((p) => [p, ...metricCells(buckets.get(p)!)]),
          notes: [METRIC_NOTE, 'Periods with no activity are omitted.'],
        });
      }),
  );
};
