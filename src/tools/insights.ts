import * as z from 'zod';
import { BREAKDOWN_DIMENSIONS, Q, type BreakdownDimension } from '../ads/queries.js';
import { addDays, todayIn } from '../ads/dates.js';
import {
  addMetrics,
  emptyMetrics,
  keywordNotation,
  METRIC_COLUMNS,
  METRIC_NOTE,
  metricCells,
  money,
  num,
  optionalMoney,
  readMetrics,
  round,
  type BaseMetrics,
} from '../ads/format.js';
import type { Row } from '../ads/client.js';
import {
  customerArgs,
  dateArgs,
  idFilter,
  limitArg,
  ok,
  openSession,
  READ_ONLY,
  runTool,
  type AdsSession,
  type ToolRegistrar,
} from './shared.js';

const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

const lastSegment = (resourceName: unknown): string => String(resourceName ?? '').split('/').pop() ?? '';

function breakdownKey(dimension: BreakdownDimension, row: Row): string {
  const seg = (row.segments ?? {}) as Row;
  switch (dimension) {
    case 'device':
      return String(seg.device ?? 'UNKNOWN');
    case 'day_of_week':
      return String(seg.dayOfWeek ?? 'UNKNOWN');
    case 'hour_of_day':
      return String(num(seg.hour));
    case 'network':
      return String(seg.adNetworkType ?? 'UNKNOWN');
    case 'city':
      return lastSegment(seg.geoTargetCity) || 'unknown';
    case 'region':
      return lastSegment(seg.geoTargetRegion) || 'unknown';
    case 'age':
      return String(row.adGroupCriterion?.ageRange?.type ?? 'UNKNOWN');
    case 'gender':
      return String(row.adGroupCriterion?.gender?.type ?? 'UNKNOWN');
  }
}

async function geoNames(s: AdsSession, ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const numeric = ids.filter((id) => /^\d+$/.test(id));
  for (let i = 0; i < numeric.length; i += 100) {
    const chunk = numeric.slice(i, i + 100);
    const { rows } = await s.rows(Q.geoTargetNames(chunk));
    for (const row of rows) {
      const g = (row.geoTargetConstant ?? {}) as Row;
      names.set(String(g.id ?? ''), String(g.canonicalName ?? g.name ?? ''));
    }
  }
  return names;
}

/** Picks the changed fields' before/after values out of a change event. */
function describeChanges(event: Row): string | null {
  const fields = String(event.changedFields ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
  if (!fields.length) return null;
  const firstValue = (resource: unknown): Row => {
    const values = Object.values((resource ?? {}) as Row);
    return (values[0] ?? {}) as Row;
  };
  const before = firstValue(event.oldResource);
  const after = firstValue(event.newResource);
  const toCamel = (path: string) => path.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const get = (obj: Row, path: string): unknown =>
    toCamel(path)
      .split('.')
      .reduce<unknown>((value, key) => (value && typeof value === 'object' ? (value as Row)[key] : undefined), obj);
  const show = (path: string, value: unknown): string => {
    if (value === undefined || value === null) return '(none)';
    if (/micros$/i.test(path) && (typeof value === 'string' || typeof value === 'number')) return String(money(value));
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  };
  const parts = fields.slice(0, 8).map((f) => `${f}: ${show(f, get(before, f))} -> ${show(f, get(after, f))}`);
  if (fields.length > 8) parts.push(`(+${fields.length - 8} more fields)`);
  const text = parts.join('; ');
  return text.length > 600 ? `${text.slice(0, 597)}...` : text;
}

export const registerInsightTools: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    'get_breakdown',
    {
      title: 'Performance breakdown',
      description:
        'Splits performance by one dimension: device, day_of_week, hour_of_day, network (Search, partners, Display, YouTube...), ' +
        'city, region, age or gender, with each slice\'s share of cost and conversions. Use it for bid adjustment and scheduling ideas.',
      inputSchema: {
        ...customerArgs,
        ...dateArgs,
        dimension: z.enum(BREAKDOWN_DIMENSIONS).describe('What to split by.'),
        campaign_id: idFilter('campaign'),
        limit: limitArg(50, 500),
      },
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      runTool(ctx, 'get_breakdown', extra, async () => {
        const s = await openSession(ctx, extra, args);
        const account = await s.clientAccount();
        const range = s.range(args, account);
        const { rows } = await s.rows(Q.breakdown(args.dimension, range, args.campaign_id));
        const buckets = new Map<string, BaseMetrics>();
        const total = emptyMetrics();
        for (const row of rows) {
          const key = breakdownKey(args.dimension, row);
          const metrics = readMetrics(row);
          addMetrics(buckets.get(key) ?? buckets.set(key, emptyMetrics()).get(key)!, metrics);
          addMetrics(total, metrics);
        }
        let keys = [...buckets.keys()];
        if (args.dimension === 'day_of_week') keys.sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
        else if (args.dimension === 'hour_of_day') keys.sort((a, b) => Number(a) - Number(b));
        else keys.sort((a, b) => buckets.get(b)!.cost - buckets.get(a)!.cost);
        const truncated = keys.length > args.limit;
        keys = keys.slice(0, args.limit);

        const geo = args.dimension === 'city' || args.dimension === 'region';
        const names = geo ? await geoNames(s, keys) : new Map<string, string>();
        const share = (part: number, whole: number) => (whole > 0 ? round((part / whole) * 100, 1) : null);
        return ok({
          ...s.header(account, range),
          dimension: args.dimension,
          campaign_id: args.campaign_id ?? null,
          columns: [args.dimension, ...(geo ? ['location_id'] : []), ...METRIC_COLUMNS, 'cost_share_pct', 'conversions_share_pct'],
          rows: keys.map((key) => {
            const m = buckets.get(key)!;
            return [
              geo ? (names.get(key) ?? key) : key,
              ...(geo ? [key] : []),
              ...metricCells(m),
              share(m.cost, total.cost),
              share(m.conversions, total.conversions),
            ];
          }),
          totals: { ...total },
          truncated,
          notes: [
            METRIC_NOTE,
            ...(geo ? ["Locations are where people were or showed interest, per the campaign's location options."] : []),
            ...(args.dimension === 'age' || args.dimension === 'gender'
              ? ['Age and gender cover Search and Display ad groups; Performance Max is not included.']
              : []),
          ],
        });
      }),
  );

  server.registerTool(
    'get_conversion_setup',
    {
      title: 'Conversion tracking setup',
      description:
        'Lists conversion actions with their settings (primary or secondary, counted in Conversions, counting type, attribution ' +
        'model, lookback window) and how many conversions each recorded in the period. Use it to judge whether tracking is trustworthy.',
      inputSchema: { ...customerArgs, ...dateArgs },
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      runTool(ctx, 'get_conversion_setup', extra, async () => {
        const s = await openSession(ctx, extra, args);
        const account = await s.clientAccount();
        const range = s.range(args, account);
        const [actions, counts] = await Promise.all([s.rows(Q.conversionActions()), s.rows(Q.conversionsByAction(range))]);
        const tally = new Map<string, { name: string; conversions: number; all: number; value: number; allValue: number }>();
        for (const row of counts.rows) {
          const id = lastSegment(row.segments?.conversionAction);
          const entry = tally.get(id) ?? { name: String(row.segments?.conversionActionName ?? ''), conversions: 0, all: 0, value: 0, allValue: 0 };
          entry.conversions += num(row.metrics?.conversions);
          entry.all += num(row.metrics?.allConversions);
          entry.value += num(row.metrics?.conversionsValue);
          entry.allValue += num(row.metrics?.allConversionsValue);
          tally.set(id, entry);
        }
        const seen = new Set<string>();
        const table: unknown[][] = actions.rows.map((row) => {
          const a = (row.conversionAction ?? {}) as Row;
          const id = String(a.id ?? '');
          seen.add(id);
          const t = tally.get(id);
          return [
            id,
            a.name ?? null,
            a.status ?? null,
            a.type ?? null,
            a.category ?? null,
            a.origin ?? null,
            a.primaryForGoal ?? null,
            a.includeInConversionsMetric ?? null,
            a.countingType ?? null,
            a.attributionModelSettings?.attributionModel ?? null,
            a.clickThroughLookbackWindowDays === undefined ? null : num(a.clickThroughLookbackWindowDays),
            round(t?.conversions ?? 0, 2),
            round(t?.all ?? 0, 2),
            round(t?.value ?? 0, 2),
            round(t?.allValue ?? 0, 2),
          ];
        });
        for (const [id, t] of tally) {
          if (!seen.has(id)) {
            table.push([id, t.name, 'NOT_IN_LIST', null, null, null, null, null, null, null, null, round(t.conversions, 2), round(t.all, 2), round(t.value, 2), round(t.allValue, 2)]);
          }
        }
        const primaryIdle = actions.rows.filter(
          (r) => r.conversionAction?.status === 'ENABLED' && r.conversionAction?.primaryForGoal === true && !(tally.get(String(r.conversionAction?.id))?.all),
        );
        return ok({
          ...s.header(account, range),
          columns: [
            'action_id',
            'name',
            'status',
            'type',
            'category',
            'origin',
            'primary_for_goal',
            'counted_in_conversions',
            'counting_type',
            'attribution_model',
            'click_lookback_days',
            'conversions',
            'all_conversions',
            'conv_value',
            'all_conv_value',
          ],
          rows: table,
          summary: {
            actions: actions.rows.length,
            enabled_primary_actions: actions.rows.filter((r) => r.conversionAction?.status === 'ENABLED' && r.conversionAction?.primaryForGoal === true).length,
            enabled_primary_with_zero_conversions: primaryIdle.map((r) => r.conversionAction?.name),
          },
          notes: [
            '"conversions" counts only actions used for bidding (primary goals); "all_conversions" includes secondary actions.',
            'An enabled primary action with zero conversions over weeks often means broken or missing tracking.',
            'Counting type ONE_PER_CLICK suits leads; MANY_PER_CLICK suits purchases.',
          ],
        });
      }),
  );

  server.registerTool(
    'get_recommendations',
    {
      title: "Google's recommendations",
      description:
        "Google's own optimization recommendations for the account (budget, keywords, bidding, assets...) with the estimated " +
        'impact Google reports. Treat them as suggestions to evaluate, not instructions: many aim to increase spend.',
      inputSchema: {
        ...customerArgs,
        types: z
          .array(z.string().regex(/^[A-Za-z_]+$/))
          .optional()
          .describe('Only these types, e.g. ["CAMPAIGN_BUDGET", "KEYWORD", "SITELINK_ASSET", "TARGET_CPA_OPT_IN"].'),
        limit: limitArg(50, 500),
      },
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      runTool(ctx, 'get_recommendations', extra, async () => {
        const s = await openSession(ctx, extra, args);
        const account = await s.clientAccount();
        const [recs, campaigns] = await Promise.all([
          s.rows(Q.recommendations({ types: args.types?.map((t) => t.toUpperCase()), limit: args.limit }), args.limit),
          s.rows(Q.campaignNames()),
        ]);
        const campaignName = new Map(campaigns.rows.map((r) => [String(r.campaign?.id ?? ''), String(r.campaign?.name ?? '')]));
        const byType: Record<string, number> = {};
        const rows = recs.rows
          .map((row) => row.recommendation as Row)
          .filter((r) => r && r.dismissed !== true)
          .map((r) => {
            const type = String(r.type ?? 'UNKNOWN');
            byType[type] = (byType[type] ?? 0) + 1;
            const base = (r.impact?.baseMetrics ?? {}) as Row;
            const potential = (r.impact?.potentialMetrics ?? {}) as Row;
            const delta = (field: string, isMoney = false) => {
              if (potential[field] === undefined && base[field] === undefined) return null;
              const diff = num(potential[field]) - num(base[field]);
              return isMoney ? money(diff) : round(diff, 2);
            };
            let details: Record<string, unknown> | null = null;
            if (r.campaignBudgetRecommendation) {
              details = {
                current_budget: optionalMoney(r.campaignBudgetRecommendation.currentBudgetAmountMicros),
                recommended_budget: optionalMoney(r.campaignBudgetRecommendation.recommendedBudgetAmountMicros),
              };
            } else if (r.keywordRecommendation) {
              details = {
                keyword: keywordNotation(r.keywordRecommendation.keyword?.text, r.keywordRecommendation.keyword?.matchType),
                recommended_cpc: optionalMoney(r.keywordRecommendation.recommendedCpcBidMicros),
              };
            }
            const campaignId = lastSegment(r.campaign);
            return [
              type,
              campaignId || null,
              campaignId ? (campaignName.get(campaignId) ?? null) : null,
              lastSegment(r.adGroup) || null,
              delta('impressions'),
              delta('clicks'),
              delta('costMicros', true),
              delta('conversions'),
              delta('conversionsValue'),
              details,
            ];
          });
        return ok({
          ...s.header(account),
          by_type: byType,
          columns: [
            'type',
            'campaign_id',
            'campaign',
            'ad_group_id',
            'est_extra_impressions',
            'est_extra_clicks',
            'est_extra_cost',
            'est_extra_conversions',
            'est_extra_conv_value',
            'details',
          ],
          rows,
          truncated: recs.truncated,
          notes: [
            'est_extra_* = potential minus base metrics as estimated by Google, per week. Null when Google gives no estimate.',
            'Use run_gaql_query on the recommendation resource for type-specific details not shown here.',
          ],
        });
      }),
  );

  server.registerTool(
    'get_change_history',
    {
      title: 'Change history',
      description:
        'Who changed what in the account and when (last 30 days at most): budgets, bids, statuses, keywords, ads, with old -> new ' +
        'values. Use it to explain sudden performance shifts.',
      inputSchema: {
        ...customerArgs,
        days: z.number().int().min(1).max(30).default(14).describe('How many days back, including today (max 30).'),
        campaign_id: idFilter('campaign'),
        resource_types: z
          .array(z.string().regex(/^[A-Za-z_]+$/))
          .optional()
          .describe('Only these resource types, e.g. ["CAMPAIGN_BUDGET", "CAMPAIGN", "AD_GROUP_CRITERION", "AD_GROUP_AD"].'),
        include_values: z.boolean().default(true).describe('Include old -> new values of the changed fields (default true).'),
        limit: limitArg(100, 1000),
      },
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      runTool(ctx, 'get_change_history', extra, async () => {
        const s = await openSession(ctx, extra, args);
        const account = await s.clientAccount();
        const today = todayIn(account.timeZone);
        const from = `${addDays(today, -(args.days - 1))} 00:00:00`;
        const to = `${today} 23:59:59`;
        const filtered = Boolean(args.campaign_id || args.resource_types?.length);
        const fetchLimit = filtered ? 1000 : args.limit;
        const [events, campaigns] = await Promise.all([s.rows(Q.changeEvents(from, to, fetchLimit), fetchLimit), s.rows(Q.campaignNames())]);
        const campaignName = new Map(campaigns.rows.map((r) => [String(r.campaign?.id ?? ''), String(r.campaign?.name ?? '')]));
        const types = new Set((args.resource_types ?? []).map((t) => t.toUpperCase()));
        let list = events.rows
          .map((row) => row.changeEvent as Row)
          .filter((e) => e && (!args.campaign_id || lastSegment(e.campaign) === args.campaign_id))
          .filter((e) => !types.size || types.has(String(e.changeResourceType)));
        const truncated = events.truncated || list.length > args.limit;
        list = list.slice(0, args.limit);

        const adGroupIds = [...new Set(list.map((e) => lastSegment(e.adGroup)).filter((id) => /^\d+$/.test(id)))];
        const adGroupName = new Map<string, string>();
        for (let i = 0; i < adGroupIds.length; i += 200) {
          const { rows } = await s.rows(Q.adGroupNames(adGroupIds.slice(i, i + 200)));
          for (const row of rows) adGroupName.set(String(row.adGroup?.id ?? ''), String(row.adGroup?.name ?? ''));
        }
        return ok({
          ...s.header(account),
          time_zone: account.timeZone,
          from,
          to,
          columns: [
            'time',
            'user',
            'client',
            'operation',
            'resource_type',
            'campaign',
            'ad_group',
            'changed_fields',
            ...(args.include_values ? ['changes'] : []),
          ],
          rows: list.map((e) => {
            const campaignId = lastSegment(e.campaign);
            const adGroupId = lastSegment(e.adGroup);
            return [
              e.changeDateTime ?? null,
              e.userEmail ?? null,
              e.clientType ?? null,
              e.resourceChangeOperation ?? null,
              e.changeResourceType ?? null,
              campaignId ? (campaignName.get(campaignId) ?? campaignId) : null,
              adGroupId ? (adGroupName.get(adGroupId) ?? adGroupId) : null,
              e.changedFields ?? null,
              ...(args.include_values ? [describeChanges(e)] : []),
            ];
          }),
          truncated,
          notes: [
            'Times are in the account time zone. Money values in changes are in the account currency.',
            ...(filtered ? ['Filters were applied to the latest 1000 changes.'] : []),
          ],
        });
      }),
  );
};
