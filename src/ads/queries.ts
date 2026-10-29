/**
 * Every GAQL query the built-in tools run. Field names and FROM-clause
 * compatibility were checked against the v26 field reference; run
 * `npm run check:gaql -- v27` before moving to a newer API version.
 *
 * Values interpolated into queries are validated here (IDs are digits, enums
 * are upper-case words, dates are YYYY-MM-DD), so tool input cannot alter a query.
 */
import { dateClause, type DateRange } from './dates.js';

export interface GaqlSpec {
  select: string[];
  from: string;
  where?: (string | false | undefined)[];
  orderBy?: string;
  limit?: number;
}

export function gaql(spec: GaqlSpec): string {
  let q = `SELECT ${spec.select.join(', ')} FROM ${spec.from}`;
  const where = (spec.where ?? []).filter((w): w is string => Boolean(w));
  if (where.length) q += ` WHERE ${where.join(' AND ')}`;
  if (spec.orderBy) q += ` ORDER BY ${spec.orderBy}`;
  if (spec.limit) q += ` LIMIT ${spec.limit}`;
  return q;
}

const id = (value: string): string => {
  if (!/^\d{1,20}$/.test(value)) throw new Error(`Invalid ID: ${value}`);
  return value;
};

const enumValue = (value: string): string => {
  if (!/^[A-Z][A-Z0-9_]*$/.test(value)) throw new Error(`Invalid enum value: ${value}`);
  return `'${value}'`;
};

const dateTime = (value: string): string => {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) throw new Error(`Invalid date-time: ${value}`);
  return `'${value}'`;
};

export const BASE_METRICS = [
  'metrics.impressions',
  'metrics.clicks',
  'metrics.cost_micros',
  'metrics.conversions',
  'metrics.conversions_value',
];

export const IMPRESSION_SHARE_METRICS = [
  'metrics.search_impression_share',
  'metrics.search_budget_lost_impression_share',
  'metrics.search_rank_lost_impression_share',
  'metrics.search_top_impression_share',
  'metrics.search_absolute_top_impression_share',
];

export const ORDER_KEYS = ['cost', 'conversions', 'clicks', 'impressions', 'conv_value'] as const;
export type OrderKey = (typeof ORDER_KEYS)[number];

const ORDER_FIELD: Record<OrderKey, string> = {
  cost: 'metrics.cost_micros',
  conversions: 'metrics.conversions',
  clicks: 'metrics.clicks',
  impressions: 'metrics.impressions',
  conv_value: 'metrics.conversions_value',
};

const orderBy = (key: OrderKey = 'cost'): string => `${ORDER_FIELD[key]} DESC`;

export const STATUS_FILTERS = ['active', 'enabled', 'paused', 'all'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

const statusWhere = (field: string, status: StatusFilter = 'active'): string | undefined =>
  status === 'active'
    ? `${field} != 'REMOVED'`
    : status === 'enabled'
      ? `${field} = 'ENABLED'`
      : status === 'paused'
        ? `${field} = 'PAUSED'`
        : undefined;

export type PerformanceFilter = 'all' | 'no_conversions' | 'converting';

const performanceWhere = (only: PerformanceFilter | string | undefined): string[] =>
  only === 'no_conversions' ? ['metrics.conversions = 0', 'metrics.cost_micros > 0'] : only === 'converting' ? ['metrics.conversions > 0'] : [];

export const BREAKDOWN_DIMENSIONS = ['device', 'day_of_week', 'hour_of_day', 'network', 'city', 'region', 'age', 'gender'] as const;
export type BreakdownDimension = (typeof BREAKDOWN_DIMENSIONS)[number];

export const Q = {
  customerBasics: (): GaqlSpec => ({
    select: [
      'customer.id',
      'customer.descriptive_name',
      'customer.currency_code',
      'customer.time_zone',
      'customer.manager',
      'customer.test_account',
      'customer.status',
    ],
    from: 'customer',
    limit: 1,
  }),

  customerSettings: (): GaqlSpec => ({
    select: ['customer.id', 'customer.optimization_score', 'customer.auto_tagging_enabled'],
    from: 'customer',
    limit: 1,
  }),

  customerClients: (): GaqlSpec => ({
    select: [
      'customer_client.id',
      'customer_client.client_customer',
      'customer_client.descriptive_name',
      'customer_client.currency_code',
      'customer_client.time_zone',
      'customer_client.manager',
      'customer_client.test_account',
      'customer_client.status',
      'customer_client.level',
      'customer_client.hidden',
    ],
    from: 'customer_client',
    where: ['customer_client.level <= 2'],
    limit: 1000,
  }),

  accountTotals: (range: DateRange): GaqlSpec => ({
    select: [...BASE_METRICS, 'metrics.all_conversions'],
    from: 'customer',
    where: [dateClause(range)],
  }),

  campaignInventory: (): GaqlSpec => ({
    select: ['campaign.id', 'campaign.status', 'campaign.advertising_channel_type'],
    from: 'campaign',
    where: ["campaign.status != 'REMOVED'"],
    limit: 10000,
  }),

  trend: (range: DateRange, granularity: 'day' | 'week' | 'month', campaignId?: string): GaqlSpec => ({
    select: [granularity === 'day' ? 'segments.date' : granularity === 'week' ? 'segments.week' : 'segments.month', ...BASE_METRICS],
    from: campaignId ? 'campaign' : 'customer',
    where: [dateClause(range), campaignId && `campaign.id = ${id(campaignId)}`],
    limit: 10000,
  }),

  campaigns: (
    range: DateRange,
    opts: { status?: StatusFilter; channelTypes?: string[]; campaignId?: string; order?: OrderKey; limit: number },
  ): GaqlSpec => ({
    select: [
      'campaign.id',
      'campaign.name',
      'campaign.status',
      'campaign.primary_status',
      'campaign.primary_status_reasons',
      'campaign.advertising_channel_type',
      'campaign.bidding_strategy_type',
      'campaign.target_cpa.target_cpa_micros',
      'campaign.target_roas.target_roas',
      'campaign.maximize_conversions.target_cpa_micros',
      'campaign.maximize_conversion_value.target_roas',
      'campaign_budget.amount_micros',
      'campaign_budget.period',
      'campaign_budget.explicitly_shared',
      ...BASE_METRICS,
      ...IMPRESSION_SHARE_METRICS,
    ],
    from: 'campaign',
    where: [
      dateClause(range),
      statusWhere('campaign.status', opts.status),
      opts.channelTypes?.length ? `campaign.advertising_channel_type IN (${opts.channelTypes.map(enumValue).join(', ')})` : undefined,
      opts.campaignId && `campaign.id = ${id(opts.campaignId)}`,
    ],
    orderBy: orderBy(opts.order),
    limit: opts.limit,
  }),

  /** Metrics only, for previous-period comparisons. */
  campaignMetrics: (range: DateRange): GaqlSpec => ({
    select: ['campaign.id', ...BASE_METRICS],
    from: 'campaign',
    where: [dateClause(range)],
    limit: 10000,
  }),

  adGroups: (
    range: DateRange,
    opts: { status?: StatusFilter; campaignId?: string; order?: OrderKey; limit: number },
  ): GaqlSpec => ({
    select: [
      'campaign.id',
      'campaign.name',
      'ad_group.id',
      'ad_group.name',
      'ad_group.status',
      'ad_group.primary_status',
      'ad_group.type',
      'ad_group.cpc_bid_micros',
      ...BASE_METRICS,
    ],
    from: 'ad_group',
    where: [
      dateClause(range),
      statusWhere('ad_group.status', opts.status),
      "campaign.status != 'REMOVED'",
      opts.campaignId && `campaign.id = ${id(opts.campaignId)}`,
    ],
    orderBy: orderBy(opts.order),
    limit: opts.limit,
  }),

  keywords: (
    range: DateRange,
    opts: { campaignId?: string; adGroupId?: string; only?: string; order?: OrderKey; limit: number },
  ): GaqlSpec => ({
    select: [
      'campaign.id',
      'campaign.name',
      'ad_group.id',
      'ad_group.name',
      'ad_group_criterion.criterion_id',
      'ad_group_criterion.keyword.text',
      'ad_group_criterion.keyword.match_type',
      'ad_group_criterion.status',
      'ad_group_criterion.primary_status',
      'ad_group_criterion.approval_status',
      'ad_group_criterion.effective_cpc_bid_micros',
      'ad_group_criterion.quality_info.quality_score',
      'ad_group_criterion.quality_info.creative_quality_score',
      'ad_group_criterion.quality_info.post_click_quality_score',
      'ad_group_criterion.quality_info.search_predicted_ctr',
      ...BASE_METRICS,
    ],
    from: 'keyword_view',
    where: [
      dateClause(range),
      "ad_group_criterion.status != 'REMOVED'",
      "ad_group.status != 'REMOVED'",
      "campaign.status != 'REMOVED'",
      opts.campaignId && `campaign.id = ${id(opts.campaignId)}`,
      opts.adGroupId && `ad_group.id = ${id(opts.adGroupId)}`,
      ...performanceWhere(opts.only),
    ],
    orderBy: orderBy(opts.order),
    limit: opts.limit,
  }),

  searchTerms: (
    range: DateRange,
    opts: { campaignId?: string; adGroupId?: string; only?: string; minClicks?: number; order?: OrderKey; limit: number },
  ): GaqlSpec => ({
    select: [
      'search_term_view.search_term',
      'search_term_view.status',
      'segments.keyword.info.text',
      'segments.keyword.info.match_type',
      'campaign.id',
      'campaign.name',
      'ad_group.id',
      'ad_group.name',
      ...BASE_METRICS,
    ],
    from: 'search_term_view',
    where: [
      dateClause(range),
      opts.campaignId && `campaign.id = ${id(opts.campaignId)}`,
      opts.adGroupId && `ad_group.id = ${id(opts.adGroupId)}`,
      opts.minClicks && opts.minClicks > 0 ? `metrics.clicks >= ${Math.floor(opts.minClicks)}` : undefined,
      ...performanceWhere(opts.only),
    ],
    orderBy: orderBy(opts.order),
    limit: opts.limit,
  }),

  ads: (
    range: DateRange,
    opts: { status?: StatusFilter; campaignId?: string; adGroupId?: string; order?: OrderKey; limit: number },
  ): GaqlSpec => ({
    select: [
      'campaign.id',
      'campaign.name',
      'ad_group.id',
      'ad_group.name',
      'ad_group_ad.ad.id',
      'ad_group_ad.ad.type',
      'ad_group_ad.ad.name',
      'ad_group_ad.ad.final_urls',
      'ad_group_ad.ad.responsive_search_ad.headlines',
      'ad_group_ad.ad.responsive_search_ad.descriptions',
      'ad_group_ad.status',
      'ad_group_ad.primary_status',
      'ad_group_ad.primary_status_reasons',
      'ad_group_ad.ad_strength',
      'ad_group_ad.policy_summary.approval_status',
      'ad_group_ad.policy_summary.review_status',
      'ad_group_ad.policy_summary.policy_topic_entries',
      ...BASE_METRICS,
    ],
    from: 'ad_group_ad',
    where: [
      dateClause(range),
      statusWhere('ad_group_ad.status', opts.status),
      "ad_group.status != 'REMOVED'",
      "campaign.status != 'REMOVED'",
      opts.campaignId && `campaign.id = ${id(opts.campaignId)}`,
      opts.adGroupId && `ad_group.id = ${id(opts.adGroupId)}`,
    ],
    orderBy: orderBy(opts.order),
    limit: opts.limit,
  }),

  /** Ads with policy problems. No metrics, so ads with zero impressions still appear. */
  adPolicyIssues: (opts: { campaignId?: string; adGroupId?: string; limit: number }): GaqlSpec => ({
    select: [
      'campaign.id',
      'campaign.name',
      'ad_group.id',
      'ad_group.name',
      'ad_group_ad.ad.id',
      'ad_group_ad.ad.type',
      'ad_group_ad.ad.name',
      'ad_group_ad.ad.final_urls',
      'ad_group_ad.ad.responsive_search_ad.headlines',
      'ad_group_ad.ad.responsive_search_ad.descriptions',
      'ad_group_ad.status',
      'ad_group_ad.primary_status',
      'ad_group_ad.primary_status_reasons',
      'ad_group_ad.ad_strength',
      'ad_group_ad.policy_summary.approval_status',
      'ad_group_ad.policy_summary.review_status',
      'ad_group_ad.policy_summary.policy_topic_entries',
    ],
    from: 'ad_group_ad',
    where: [
      "ad_group_ad.policy_summary.approval_status IN ('DISAPPROVED', 'APPROVED_LIMITED', 'AREA_OF_INTEREST_ONLY')",
      "ad_group_ad.status != 'REMOVED'",
      "ad_group.status != 'REMOVED'",
      "campaign.status != 'REMOVED'",
      opts.campaignId && `campaign.id = ${id(opts.campaignId)}`,
      opts.adGroupId && `ad_group.id = ${id(opts.adGroupId)}`,
    ],
    limit: opts.limit,
  }),

  assetGroups: (range: DateRange, opts: { campaignId?: string; order?: OrderKey; limit: number }): GaqlSpec => ({
    select: [
      'campaign.id',
      'campaign.name',
      'asset_group.id',
      'asset_group.name',
      'asset_group.status',
      'asset_group.primary_status',
      'asset_group.primary_status_reasons',
      'asset_group.ad_strength',
      ...BASE_METRICS,
    ],
    from: 'asset_group',
    where: [
      dateClause(range),
      "asset_group.status != 'REMOVED'",
      "campaign.status != 'REMOVED'",
      opts.campaignId && `campaign.id = ${id(opts.campaignId)}`,
    ],
    orderBy: orderBy(opts.order),
    limit: opts.limit,
  }),

  breakdown: (dimension: BreakdownDimension, range: DateRange, campaignId?: string): GaqlSpec => {
    const campaignFilter = campaignId ? `campaign.id = ${id(campaignId)}` : undefined;
    switch (dimension) {
      case 'device':
      case 'day_of_week':
      case 'hour_of_day':
      case 'network': {
        const segment = {
          device: 'segments.device',
          day_of_week: 'segments.day_of_week',
          hour_of_day: 'segments.hour',
          network: 'segments.ad_network_type',
        }[dimension];
        return { select: [segment, ...BASE_METRICS], from: 'campaign', where: [dateClause(range), campaignFilter], limit: 10000 };
      }
      case 'city':
      case 'region': {
        const segment = dimension === 'city' ? 'segments.geo_target_city' : 'segments.geo_target_region';
        // campaign is a segmenting resource of geographic_view: select it when filtering on it.
        return {
          select: [segment, ...(campaignId ? ['campaign.id'] : []), ...BASE_METRICS],
          from: 'geographic_view',
          where: [dateClause(range), campaignFilter],
          limit: 10000,
        };
      }
      case 'age':
        return {
          select: ['ad_group_criterion.age_range.type', ...BASE_METRICS],
          from: 'age_range_view',
          where: [dateClause(range), campaignFilter],
          limit: 10000,
        };
      case 'gender':
        return {
          select: ['ad_group_criterion.gender.type', ...BASE_METRICS],
          from: 'gender_view',
          where: [dateClause(range), campaignFilter],
          limit: 10000,
        };
    }
  },

  geoTargetNames: (geoIds: string[]): GaqlSpec => ({
    select: [
      'geo_target_constant.id',
      'geo_target_constant.name',
      'geo_target_constant.canonical_name',
      'geo_target_constant.target_type',
      'geo_target_constant.country_code',
    ],
    from: 'geo_target_constant',
    where: [`geo_target_constant.resource_name IN (${geoIds.map((g) => `'geoTargetConstants/${id(g)}'`).join(', ')})`],
    limit: geoIds.length,
  }),

  languageByCode: (code: string): GaqlSpec => {
    if (!/^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(code)) throw new Error(`Invalid language code: ${code}`);
    return {
      select: ['language_constant.id', 'language_constant.code', 'language_constant.name', 'language_constant.targetable'],
      from: 'language_constant',
      where: [`language_constant.code = '${code.toLowerCase()}'`],
      limit: 5,
    };
  },

  budgetCampaigns: (): GaqlSpec => ({
    select: [
      'campaign.id',
      'campaign.name',
      'campaign.status',
      'campaign.primary_status',
      'campaign.primary_status_reasons',
      'campaign.advertising_channel_type',
      'campaign.campaign_budget',
      'campaign_budget.amount_micros',
      'campaign_budget.period',
      'campaign_budget.total_amount_micros',
      'campaign_budget.explicitly_shared',
    ],
    from: 'campaign',
    where: ["campaign.status = 'ENABLED'"],
    limit: 5000,
  }),

  campaignSpend: (range: DateRange): GaqlSpec => ({
    select: ['campaign.id', 'metrics.cost_micros', 'metrics.conversions', 'metrics.search_budget_lost_impression_share'],
    from: 'campaign',
    where: [dateClause(range)],
    limit: 10000,
  }),

  conversionActions: (): GaqlSpec => ({
    select: [
      'conversion_action.id',
      'conversion_action.name',
      'conversion_action.status',
      'conversion_action.type',
      'conversion_action.category',
      'conversion_action.origin',
      'conversion_action.primary_for_goal',
      'conversion_action.include_in_conversions_metric',
      'conversion_action.counting_type',
      'conversion_action.click_through_lookback_window_days',
      'conversion_action.attribution_model_settings.attribution_model',
    ],
    from: 'conversion_action',
    where: ["conversion_action.status != 'REMOVED'"],
    limit: 1000,
  }),

  conversionsByAction: (range: DateRange): GaqlSpec => ({
    select: [
      'segments.conversion_action',
      'segments.conversion_action_name',
      'metrics.conversions',
      'metrics.all_conversions',
      'metrics.conversions_value',
      'metrics.all_conversions_value',
    ],
    from: 'campaign',
    where: [dateClause(range)],
    limit: 10000,
  }),

  campaignNegatives: (opts: { campaignId?: string; limit: number }): GaqlSpec => ({
    select: ['campaign.id', 'campaign.name', 'campaign_criterion.keyword.text', 'campaign_criterion.keyword.match_type'],
    from: 'campaign_criterion',
    where: [
      'campaign_criterion.negative = TRUE',
      "campaign_criterion.type = 'KEYWORD'",
      "campaign.status != 'REMOVED'",
      opts.campaignId && `campaign.id = ${id(opts.campaignId)}`,
    ],
    limit: opts.limit,
  }),

  adGroupNegatives: (opts: { campaignId?: string; limit: number }): GaqlSpec => ({
    select: [
      'campaign.id',
      'campaign.name',
      'ad_group.id',
      'ad_group.name',
      'ad_group_criterion.keyword.text',
      'ad_group_criterion.keyword.match_type',
    ],
    from: 'ad_group_criterion',
    where: [
      'ad_group_criterion.negative = TRUE',
      "ad_group_criterion.type = 'KEYWORD'",
      "ad_group_criterion.status != 'REMOVED'",
      "ad_group.status != 'REMOVED'",
      "campaign.status != 'REMOVED'",
      opts.campaignId && `campaign.id = ${id(opts.campaignId)}`,
    ],
    limit: opts.limit,
  }),

  sharedNegatives: (limit: number): GaqlSpec => ({
    select: ['shared_set.id', 'shared_set.name', 'shared_set.type', 'shared_criterion.keyword.text', 'shared_criterion.keyword.match_type'],
    from: 'shared_criterion',
    where: [
      "shared_set.type IN ('NEGATIVE_KEYWORDS', 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS')",
      "shared_set.status = 'ENABLED'",
      "shared_criterion.type = 'KEYWORD'",
    ],
    limit,
  }),

  sharedNegativeLinks: (): GaqlSpec => ({
    select: ['campaign.id', 'campaign.name', 'shared_set.id', 'shared_set.name'],
    from: 'campaign_shared_set',
    where: ["shared_set.type = 'NEGATIVE_KEYWORDS'", "campaign_shared_set.status = 'ENABLED'", "campaign.status != 'REMOVED'"],
    limit: 10000,
  }),

  recommendations: (opts: { types?: string[]; limit: number }): GaqlSpec => ({
    select: [
      'recommendation.resource_name',
      'recommendation.type',
      'recommendation.campaign',
      'recommendation.ad_group',
      'recommendation.dismissed',
      'recommendation.impact',
      'recommendation.campaign_budget_recommendation',
      'recommendation.keyword_recommendation',
    ],
    from: 'recommendation',
    where: [opts.types?.length ? `recommendation.type IN (${opts.types.map(enumValue).join(', ')})` : undefined],
    limit: opts.limit,
  }),

  campaignNames: (): GaqlSpec => ({ select: ['campaign.id', 'campaign.name'], from: 'campaign', limit: 10000 }),

  adGroupNames: (adGroupIds: string[]): GaqlSpec => ({
    select: ['ad_group.id', 'ad_group.name'],
    from: 'ad_group',
    where: [`ad_group.id IN (${adGroupIds.map(id).join(', ')})`],
    limit: adGroupIds.length,
  }),

  changeEvents: (from: string, to: string, limit: number): GaqlSpec => ({
    select: [
      'change_event.change_date_time',
      'change_event.change_resource_type',
      'change_event.change_resource_name',
      'change_event.resource_change_operation',
      'change_event.changed_fields',
      'change_event.user_email',
      'change_event.client_type',
      'change_event.campaign',
      'change_event.ad_group',
      'change_event.old_resource',
      'change_event.new_resource',
    ],
    from: 'change_event',
    where: [`change_event.change_date_time >= ${dateTime(from)}`, `change_event.change_date_time <= ${dateTime(to)}`],
    orderBy: 'change_event.change_date_time DESC',
    limit,
  }),
};

/** Appends a LIMIT when the query has none, keeping any PARAMETERS clause last. */
export function withLimit(query: string, limit: number): string {
  if (/\bLIMIT\s+\d+/i.test(query)) return query;
  const params = query.search(/\bPARAMETERS\b/i);
  return params >= 0
    ? `${query.slice(0, params).trimEnd()} LIMIT ${limit} ${query.slice(params)}`
    : `${query.trimEnd().replace(/;$/, '')} LIMIT ${limit}`;
}
