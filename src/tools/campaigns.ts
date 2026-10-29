import * as z from 'zod';
import { Q } from '../ads/queries.js';
import { addDays, daysInclusive, daysInMonth, previousPeriod, todayIn, type DateRange } from '../ads/dates.js';
import {
  addMetrics,
  changePct,
  derive,
  emptyMetrics,
  METRIC_COLUMNS,
  METRIC_NOTE,
  metricCells,
  money,
  num,
  optionalMoney,
  percent,
  readMetrics,
  round,
  type BaseMetrics,
} from '../ads/format.js';
import type { Row } from '../ads/client.js';
import {
  customerArgs,
  dateArgs,
  idFilter,
  joinList,
  limitArg,
  ok,
  openSession,
  orderArg,
  READ_ONLY,
  runTool,
  statusArg,
  type ToolRegistrar,
} from './shared.js';

/** Human-readable bidding target, e.g. "tCPA 250" or "tROAS 400%". */
function biddingTarget(c: Row): string | null {
  const tcpa = c.targetCpa?.targetCpaMicros ?? c.maximizeConversions?.targetCpaMicros;
  if (tcpa !== undefined && num(tcpa) > 0) return `tCPA ${money(tcpa)}`;
  const troas = c.targetRoas?.targetRoas ?? c.maximizeConversionValue?.targetRoas;
  if (troas !== undefined && num(troas) > 0) return `tROAS ${round(num(troas) * 100, 0)}%`;
  return null;
}

export const registerCampaignTools: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    'get_campaign_performance',
    {
      title: 'Campaign performance',
      description:
        'Per-campaign results for a period with status and why it is limited (primary_status_reasons), channel, bidding strategy and target, ' +
        'daily budget, all core metrics, and Search impression share lost to budget vs rank. Optionally compares with the previous period.',
      inputSchema: {
        ...customerArgs,
        ...dateArgs,
        status: statusArg,
        channel_types: z
          .array(z.string().regex(/^[A-Za-z_]+$/))
          .optional()
          .describe('Only these channels, e.g. ["SEARCH", "PERFORMANCE_MAX"]. Others: DISPLAY, SHOPPING, VIDEO, DEMAND_GEN, MULTI_CHANNEL, LOCAL, SMART.'),
        campaign_id: idFilter('campaign'),
        order_by: orderArg,
        compare: z.boolean().default(false).describe('Add previous-period cost, conversions and CPA with % change.'),
        limit: limitArg(50, 500),
      },
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      runTool(ctx, 'get_campaign_performance', extra, async () => {
        const s = await openSession(ctx, extra, args);
        const account = await s.clientAccount();
        const range = s.range(args, account);
        const { rows, truncated } = await s.rows(
          Q.campaigns(range, {
            status: args.status,
            channelTypes: args.channel_types?.map((c) => c.toUpperCase()),
            campaignId: args.campaign_id,
            order: args.order_by,
            limit: args.limit,
          }),
          args.limit,
        );

        let previous: Map<string, BaseMetrics> | undefined;
        if (args.compare) {
          previous = new Map();
          for (const row of (await s.rows(Q.campaignMetrics(previousPeriod(range)))).rows) {
            const id = String(row.campaign?.id ?? '');
            addMetrics(previous.get(id) ?? previous.set(id, emptyMetrics()).get(id)!, readMetrics(row));
          }
        }

        const columns = [
          'campaign_id',
          'campaign',
          'status',
          'primary_status',
          'primary_status_reasons',
          'channel',
          'bidding',
          'target',
          'budget',
          'budget_period',
          'shared_budget',
          ...METRIC_COLUMNS,
          'search_is',
          'search_lost_is_budget',
          'search_lost_is_rank',
          'search_top_is',
          'search_abs_top_is',
          ...(previous ? ['prev_cost', 'cost_change_pct', 'prev_conversions', 'conversions_change_pct', 'prev_cpa', 'cpa_change_pct'] : []),
        ];
        const table = rows.map((row) => {
          const c = (row.campaign ?? {}) as Row;
          const b = (row.campaignBudget ?? {}) as Row;
          const m = (row.metrics ?? {}) as Row;
          const base = readMetrics(row);
          const cells: unknown[] = [
            String(c.id ?? ''),
            c.name ?? null,
            c.status ?? null,
            c.primaryStatus ?? null,
            joinList(c.primaryStatusReasons),
            c.advertisingChannelType ?? null,
            c.biddingStrategyType ?? null,
            biddingTarget(c),
            optionalMoney(b.amountMicros),
            b.period ?? null,
            b.explicitlyShared === true,
            ...metricCells(base),
            percent(m.searchImpressionShare),
            percent(m.searchBudgetLostImpressionShare),
            percent(m.searchRankLostImpressionShare),
            percent(m.searchTopImpressionShare),
            percent(m.searchAbsoluteTopImpressionShare),
          ];
          if (previous) {
            const p = previous.get(String(c.id ?? '')) ?? emptyMetrics();
            const cpa = derive(base).cpa;
            const prevCpa = derive(p).cpa;
            cells.push(
              p.cost,
              changePct(base.cost, p.cost),
              p.conversions,
              changePct(base.conversions, p.conversions),
              prevCpa,
              cpa !== null && prevCpa !== null ? changePct(cpa, prevCpa) : null,
            );
          }
          return cells;
        });
        return ok({
          ...s.header(account, range),
          ...(previous ? { previous_period: previousPeriod(range) } : {}),
          columns,
          rows: table,
          truncated,
          notes: [
            METRIC_NOTE,
            'Impression share columns are percentages and apply to Search only (null elsewhere); Google reports "<10%" as 9.99.',
            'search_lost_is_budget high = budget-limited; search_lost_is_rank high = bid or Quality Score limited.',
            'Campaigns with no activity in the period may be missing.',
          ],
        });
      }),
  );

  server.registerTool(
    'get_ad_group_performance',
    {
      title: 'Ad group performance',
      description: 'Per-ad-group results for a period, with status, type and default max CPC. Filter to one campaign with campaign_id.',
      inputSchema: {
        ...customerArgs,
        ...dateArgs,
        campaign_id: idFilter('campaign'),
        status: statusArg,
        order_by: orderArg,
        limit: limitArg(50, 1000),
      },
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      runTool(ctx, 'get_ad_group_performance', extra, async () => {
        const s = await openSession(ctx, extra, args);
        const account = await s.clientAccount();
        const range = s.range(args, account);
        const { rows, truncated } = await s.rows(
          Q.adGroups(range, { status: args.status, campaignId: args.campaign_id, order: args.order_by, limit: args.limit }),
          args.limit,
        );
        return ok({
          ...s.header(account, range),
          columns: ['campaign_id', 'campaign', 'ad_group_id', 'ad_group', 'status', 'primary_status', 'type', 'default_max_cpc', ...METRIC_COLUMNS],
          rows: rows.map((row) => [
            String(row.campaign?.id ?? ''),
            row.campaign?.name ?? null,
            String(row.adGroup?.id ?? ''),
            row.adGroup?.name ?? null,
            row.adGroup?.status ?? null,
            row.adGroup?.primaryStatus ?? null,
            row.adGroup?.type ?? null,
            optionalMoney(row.adGroup?.cpcBidMicros),
            ...metricCells(readMetrics(row)),
          ]),
          truncated,
          notes: [METRIC_NOTE],
        });
      }),
  );

  server.registerTool(
    'get_asset_group_performance',
    {
      title: 'Performance Max asset groups',
      description: 'Per-asset-group results for Performance Max campaigns, with status, limiting reasons and ad strength.',
      inputSchema: {
        ...customerArgs,
        ...dateArgs,
        campaign_id: idFilter('Performance Max campaign'),
        order_by: orderArg,
        limit: limitArg(50, 500),
      },
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      runTool(ctx, 'get_asset_group_performance', extra, async () => {
        const s = await openSession(ctx, extra, args);
        const account = await s.clientAccount();
        const range = s.range(args, account);
        const { rows, truncated } = await s.rows(
          Q.assetGroups(range, { campaignId: args.campaign_id, order: args.order_by, limit: args.limit }),
          args.limit,
        );
        return ok({
          ...s.header(account, range),
          columns: [
            'campaign_id',
            'campaign',
            'asset_group_id',
            'asset_group',
            'status',
            'primary_status',
            'primary_status_reasons',
            'ad_strength',
            ...METRIC_COLUMNS,
          ],
          rows: rows.map((row) => [
            String(row.campaign?.id ?? ''),
            row.campaign?.name ?? null,
            String(row.assetGroup?.id ?? ''),
            row.assetGroup?.name ?? null,
            row.assetGroup?.status ?? null,
            row.assetGroup?.primaryStatus ?? null,
            joinList(row.assetGroup?.primaryStatusReasons),
            row.assetGroup?.adStrength ?? null,
            ...metricCells(readMetrics(row)),
          ]),
          truncated,
          notes: [METRIC_NOTE],
        });
      }),
  );

  server.registerTool(
    'get_budget_pacing',
    {
      title: 'Budget pacing',
      description:
        'Month-to-date spend for every enabled campaign against its budget: average daily spend over the last 7 full days, budget ' +
        'utilization, projected month-end spend, Search impression share lost to budget, and account totals. Use for over/under-spend questions.',
      inputSchema: { ...customerArgs },
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      runTool(ctx, 'get_budget_pacing', extra, async () => {
        const s = await openSession(ctx, extra, args);
        const account = await s.clientAccount();
        const today = todayIn(account.timeZone);
        const monthStart = `${today.slice(0, 8)}01`;
        const mtd: DateRange = { start: monthStart, end: today, label: 'this_month', days: daysInclusive(monthStart, today) };
        const last7: DateRange = { start: addDays(today, -7), end: addDays(today, -1), label: 'last_7_days', days: 7 };
        const monthDays = daysInMonth(today);
        const daysRemaining = monthDays - Number(today.slice(8, 10));

        const [budgets, mtdSpend, recentSpend] = await Promise.all([
          s.rows(Q.budgetCampaigns()),
          s.rows(Q.campaignSpend(mtd)),
          s.rows(Q.campaignSpend(last7)),
        ]);
        const spend = (rows: Row[]) => {
          const map = new Map<string, { cost: number; conversions: number; lostBudget: number | null }>();
          for (const row of rows) {
            const id = String(row.campaign?.id ?? '');
            const entry = map.get(id) ?? { cost: 0, conversions: 0, lostBudget: null };
            entry.cost = round(entry.cost + money(row.metrics?.costMicros), 2);
            entry.conversions = round(entry.conversions + num(row.metrics?.conversions), 2);
            const lost = percent(row.metrics?.searchBudgetLostImpressionShare);
            if (lost !== null) entry.lostBudget = lost;
            map.set(id, entry);
          }
          return map;
        };
        const mtdMap = spend(mtdSpend.rows);
        const recentMap = spend(recentSpend.rows);

        const seenBudgets = new Set<string>();
        const totals = { daily_budget: 0, mtd_spend: 0, projected_month_spend: 0 };
        const records = budgets.rows.map((row) => {
          const c = (row.campaign ?? {}) as Row;
          const b = (row.campaignBudget ?? {}) as Row;
          const id = String(c.id ?? '');
          const daily = b.period === 'DAILY' || b.period === undefined ? optionalMoney(b.amountMicros) : null;
          const spent = mtdMap.get(id)?.cost ?? 0;
          const avg7 = round((recentMap.get(id)?.cost ?? 0) / 7, 2);
          const projected = round(spent + avg7 * daysRemaining, 2);
          const budgetKey = String(c.campaignBudget ?? id);
          if (daily !== null && !seenBudgets.has(budgetKey)) {
            seenBudgets.add(budgetKey);
            totals.daily_budget = round(totals.daily_budget + daily, 2);
          }
          totals.mtd_spend = round(totals.mtd_spend + spent, 2);
          totals.projected_month_spend = round(totals.projected_month_spend + projected, 2);
          return [
            id,
            c.name ?? null,
            c.advertisingChannelType ?? null,
            c.primaryStatus ?? null,
            joinList(c.primaryStatusReasons),
            daily,
            b.period ?? null,
            b.explicitlyShared === true,
            optionalMoney(b.totalAmountMicros),
            spent,
            mtdMap.get(id)?.conversions ?? 0,
            avg7,
            daily ? round((avg7 / daily) * 100, 1) : null,
            projected,
            daily ? round(daily * 30.4, 2) : null,
            mtdMap.get(id)?.lostBudget ?? null,
          ];
        });
        records.sort((a, b) => Number(b[9]) - Number(a[9]));
        return ok({
          ...s.header(account),
          today,
          month: { start: monthStart, days_in_month: monthDays, days_elapsed: mtd.days, days_remaining_after_today: daysRemaining },
          last_7_days: { start: last7.start, end: last7.end },
          columns: [
            'campaign_id',
            'campaign',
            'channel',
            'primary_status',
            'primary_status_reasons',
            'daily_budget',
            'budget_period',
            'shared_budget',
            'total_budget',
            'mtd_spend',
            'mtd_conversions',
            'avg_daily_spend_7d',
            'utilization_pct',
            'projected_month_spend',
            'max_month_charge',
            'mtd_search_lost_is_budget',
          ],
          rows: records,
          totals,
          notes: [
            'utilization_pct = average daily spend over the last 7 full days / daily budget.',
            'projected_month_spend = month-to-date spend + 7-day average x full days left after today (today is partial).',
            'max_month_charge = daily budget x 30.4, the most Google bills in a month for a daily budget; single days may reach 2x budget.',
            'Shared budgets are counted once in totals.daily_budget.',
          ],
        });
      }),
  );
};
