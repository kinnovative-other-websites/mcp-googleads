import * as z from 'zod';
import { Q } from '../ads/queries.js';
import { keywordNotation, METRIC_COLUMNS, METRIC_NOTE, metricCells, money, num, optionalMoney, readMetrics } from '../ads/format.js';
import type { Row } from '../ads/client.js';
import {
  customerArgs,
  dateArgs,
  idFilter,
  limitArg,
  ok,
  openSession,
  orderArg,
  READ_ONLY,
  runTool,
  ToolInputError,
  type ToolRegistrar,
} from './shared.js';

const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

export const registerKeywordTools: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    'get_keyword_performance',
    {
      title: 'Keyword performance',
      description:
        'Search keywords with match type, status, Quality Score and its components (expected CTR, ad relevance, landing page ' +
        'experience), max CPC and metrics. Filter to wasted spend (no_conversions), converters, or low Quality Score.',
      inputSchema: {
        ...customerArgs,
        ...dateArgs,
        campaign_id: idFilter('campaign'),
        ad_group_id: idFilter('ad group'),
        only: z
          .enum(['all', 'no_conversions', 'converting'])
          .default('all')
          .describe('no_conversions = spent money with zero conversions; converting = at least one conversion.'),
        max_quality_score: z.number().int().min(1).max(10).optional().describe('Only keywords with Quality Score at or below this (e.g. 4).'),
        order_by: orderArg,
        limit: limitArg(100, 1000),
      },
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      runTool(ctx, 'get_keyword_performance', extra, async () => {
        const s = await openSession(ctx, extra, args);
        const account = await s.clientAccount();
        const range = s.range(args, account);
        const fetchLimit = args.max_quality_score ? 1000 : args.limit;
        const result = await s.rows(
          Q.keywords(range, {
            campaignId: args.campaign_id,
            adGroupId: args.ad_group_id,
            only: args.only,
            order: args.order_by,
            limit: fetchLimit,
          }),
          fetchLimit,
        );
        let rows = result.rows;
        if (args.max_quality_score) {
          rows = rows.filter((r) => {
            const qs = r.adGroupCriterion?.qualityInfo?.qualityScore;
            return qs !== undefined && num(qs) <= args.max_quality_score!;
          });
        }
        const truncated = result.truncated || rows.length > args.limit;
        rows = rows.slice(0, args.limit);
        return ok({
          ...s.header(account, range),
          columns: [
            'campaign_id',
            'campaign',
            'ad_group_id',
            'ad_group',
            'criterion_id',
            'keyword',
            'match_type',
            'status',
            'primary_status',
            'approval_status',
            'quality_score',
            'expected_ctr',
            'ad_relevance',
            'landing_page_experience',
            'max_cpc',
            ...METRIC_COLUMNS,
          ],
          rows: rows.map((row) => {
            const k = (row.adGroupCriterion ?? {}) as Row;
            const q = (k.qualityInfo ?? {}) as Row;
            return [
              String(row.campaign?.id ?? ''),
              row.campaign?.name ?? null,
              String(row.adGroup?.id ?? ''),
              row.adGroup?.name ?? null,
              String(k.criterionId ?? ''),
              keywordNotation(k.keyword?.text, k.keyword?.matchType),
              k.keyword?.matchType ?? null,
              k.status ?? null,
              k.primaryStatus ?? null,
              k.approvalStatus ?? null,
              q.qualityScore === undefined ? null : num(q.qualityScore),
              q.searchPredictedCtr ?? null,
              q.creativeQualityScore ?? null,
              q.postClickQualityScore ?? null,
              optionalMoney(k.effectiveCpcBidMicros),
              ...metricCells(readMetrics(row)),
            ];
          }),
          truncated,
          notes: [
            METRIC_NOTE,
            'keyword uses Google Ads notation: [exact], "phrase", broad. Quality Score is null until a keyword has enough traffic.',
            ...(args.max_quality_score ? ['Quality Score filter applied to the top 1000 keywords by the chosen sort order.'] : []),
          ],
        });
      }),
  );

  server.registerTool(
    'get_search_terms',
    {
      title: 'Search terms report',
      description:
        'What people actually searched before clicking, with the keyword that matched, whether the term is already a keyword ' +
        '(ADDED) or excluded (EXCLUDED), and metrics. Use no_conversions to find negative keyword candidates and converting to find new keywords.',
      inputSchema: {
        ...customerArgs,
        ...dateArgs,
        campaign_id: idFilter('campaign'),
        ad_group_id: idFilter('ad group'),
        only: z.enum(['all', 'no_conversions', 'converting']).default('all').describe('no_conversions = cost but zero conversions.'),
        min_clicks: z.number().int().min(0).default(0).describe('Only terms with at least this many clicks.'),
        order_by: orderArg,
        limit: limitArg(100, 1000),
      },
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      runTool(ctx, 'get_search_terms', extra, async () => {
        const s = await openSession(ctx, extra, args);
        const account = await s.clientAccount();
        const range = s.range(args, account);
        const { rows, truncated } = await s.rows(
          Q.searchTerms(range, {
            campaignId: args.campaign_id,
            adGroupId: args.ad_group_id,
            only: args.only,
            minClicks: args.min_clicks,
            order: args.order_by,
            limit: args.limit,
          }),
          args.limit,
        );
        return ok({
          ...s.header(account, range),
          columns: ['search_term', 'term_status', 'matched_keyword', 'campaign_id', 'campaign', 'ad_group_id', 'ad_group', ...METRIC_COLUMNS],
          rows: rows.map((row) => [
            row.searchTermView?.searchTerm ?? null,
            row.searchTermView?.status ?? null,
            row.segments?.keyword?.info ? keywordNotation(row.segments.keyword.info.text, row.segments.keyword.info.matchType) : null,
            String(row.campaign?.id ?? ''),
            row.campaign?.name ?? null,
            String(row.adGroup?.id ?? ''),
            row.adGroup?.name ?? null,
            ...metricCells(readMetrics(row)),
          ]),
          truncated,
          notes: [
            METRIC_NOTE,
            'term_status: ADDED = already a keyword, EXCLUDED = already a negative, ADDED_EXCLUDED = both, NONE = neither.',
            'Google withholds low-volume terms for privacy, and Performance Max terms are not in this report.',
            'Before suggesting negatives, check get_negative_keywords so you do not repeat existing ones.',
          ],
        });
      }),
  );

  server.registerTool(
    'get_negative_keywords',
    {
      title: 'Negative keywords',
      description:
        'Existing negative keywords at campaign level, ad group level, and in shared negative keyword lists (including ' +
        'account-level lists), with the campaigns each list is applied to. Check this before recommending new negatives.',
      inputSchema: {
        ...customerArgs,
        campaign_id: idFilter('campaign'),
        limit: limitArg(2000, 10000).describe('Maximum negatives to read per level (default 2000).'),
      },
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      runTool(ctx, 'get_negative_keywords', extra, async () => {
        const s = await openSession(ctx, extra, args);
        const account = await s.clientAccount();
        const [campaignLevel, adGroupLevel, shared, links] = await Promise.all([
          s.rows(Q.campaignNegatives({ campaignId: args.campaign_id, limit: args.limit }), args.limit),
          s.rows(Q.adGroupNegatives({ campaignId: args.campaign_id, limit: args.limit }), args.limit),
          s.rows(Q.sharedNegatives(args.limit), args.limit),
          s.rows(Q.sharedNegativeLinks()),
        ]);

        type CampaignNegatives = { campaign_id: string; campaign: string; negatives: string[] };
        type AdGroupNegatives = { campaign: string; ad_group_id: string; ad_group: string; negatives: string[] };
        type ListNegatives = { list_id: string; list: string; type: string; applied_to: string[]; negatives: string[] };
        const byCampaign = new Map<string, CampaignNegatives>();
        for (const row of campaignLevel.rows) {
          const id = String(row.campaign?.id ?? '');
          const entry: CampaignNegatives = byCampaign.get(id) ?? { campaign_id: id, campaign: row.campaign?.name ?? '', negatives: [] };
          entry.negatives.push(keywordNotation(row.campaignCriterion?.keyword?.text, row.campaignCriterion?.keyword?.matchType));
          byCampaign.set(id, entry);
        }
        const byAdGroup = new Map<string, AdGroupNegatives>();
        for (const row of adGroupLevel.rows) {
          const id = String(row.adGroup?.id ?? '');
          const entry: AdGroupNegatives = byAdGroup.get(id) ?? { campaign: row.campaign?.name ?? '', ad_group_id: id, ad_group: row.adGroup?.name ?? '', negatives: [] };
          entry.negatives.push(keywordNotation(row.adGroupCriterion?.keyword?.text, row.adGroupCriterion?.keyword?.matchType));
          byAdGroup.set(id, entry);
        }
        const appliedTo = new Map<string, { id: string; name: string }[]>();
        for (const row of links.rows) {
          const listId = String(row.sharedSet?.id ?? '');
          const list = appliedTo.get(listId) ?? [];
          list.push({ id: String(row.campaign?.id ?? ''), name: row.campaign?.name ?? '' });
          appliedTo.set(listId, list);
        }
        const lists = new Map<string, ListNegatives>();
        for (const row of shared.rows) {
          const id = String(row.sharedSet?.id ?? '');
          const type = String(row.sharedSet?.type ?? '');
          const campaigns = appliedTo.get(id) ?? [];
          if (args.campaign_id && type !== 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS' && !campaigns.some((c) => c.id === args.campaign_id)) continue;
          const entry: ListNegatives = lists.get(id) ?? {
            list_id: id,
            list: row.sharedSet?.name ?? '',
            type,
            applied_to: type === 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS' ? ['(whole account)'] : campaigns.map((c) => c.name),
            negatives: [],
          };
          entry.negatives.push(keywordNotation(row.sharedCriterion?.keyword?.text, row.sharedCriterion?.keyword?.matchType));
          lists.set(id, entry);
        }
        return ok({
          ...s.header(account),
          campaign_id: args.campaign_id ?? null,
          campaign_level: [...byCampaign.values()],
          ad_group_level: [...byAdGroup.values()],
          shared_lists: [...lists.values()],
          truncated: campaignLevel.truncated || adGroupLevel.truncated || shared.truncated,
          notes: ['Notation: [exact], "phrase", broad. Negative keywords do not match close variants the way positive keywords do.'],
        });
      }),
  );

  server.registerTool(
    'generate_keyword_ideas',
    {
      title: 'Keyword ideas (Keyword Planner)',
      description:
        'Keyword Planner ideas from seed keywords and/or a URL: average monthly searches, competition, and top-of-page bid ' +
        'range in the account currency, for chosen locations and language. Read-only; nothing is added to the account.',
      inputSchema: {
        ...customerArgs,
        keywords: z.array(z.string().min(1).max(80)).max(20).optional().describe('Seed keywords, up to 20.'),
        url: z.string().url().optional().describe('Seed page or site URL.'),
        locations: z
          .array(z.string().min(1))
          .max(10)
          .optional()
          .describe('Locations by name ("Hyderabad", "India") or geo target ID ("2356"). Default: all locations.'),
        language: z.string().default('en').describe('Language code (en, hi, te, ...) or language constant ID (1000 = English). Default en.'),
        network: z.enum(['google_search', 'google_search_and_partners']).default('google_search'),
        limit: limitArg(50, 500),
      },
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      runTool(ctx, 'generate_keyword_ideas', extra, async () => {
        if (!args.keywords?.length && !args.url) throw new ToolInputError('Provide keywords, url, or both.');
        const s = await openSession(ctx, extra, args);
        const account = await s.clientAccount();

        let language: { resource: string; name: string };
        if (/^\d+$/.test(args.language)) {
          language = { resource: `languageConstants/${args.language}`, name: args.language };
        } else {
          let found: Row | undefined;
          try {
            found = (await s.rows(Q.languageByCode(args.language))).rows[0]?.languageConstant;
          } catch (error) {
            if ((error as Error).message.startsWith('Invalid language code')) throw new ToolInputError((error as Error).message);
            throw error;
          }
          if (!found) throw new ToolInputError(`Unknown language code "${args.language}". Use a code like en, hi, te, or a numeric ID.`);
          language = { resource: `languageConstants/${found.id}`, name: String(found.name ?? args.language) };
        }

        const geo: { input: string; resource: string; name: string }[] = [];
        const names = (args.locations ?? []).filter((l) => !/^\d+$/.test(l));
        for (const l of args.locations ?? []) if (/^\d+$/.test(l)) geo.push({ input: l, resource: `geoTargetConstants/${l}`, name: l });
        if (names.length) {
          const response = await ctx.ads.suggestGeoTargets(s.auth, { locale: 'en', locationNames: { names } });
          const suggestions = (response.geoTargetConstantSuggestions as Row[] | undefined) ?? [];
          for (const name of names) {
            const match = suggestions.find((g) => String(g.searchTerm ?? '').toLowerCase() === name.toLowerCase());
            if (!match?.geoTargetConstant?.resourceName) {
              throw new ToolInputError(`Could not find a location named "${name}". Try a broader name or a geo target ID.`);
            }
            geo.push({
              input: name,
              resource: match.geoTargetConstant.resourceName,
              name: String(match.geoTargetConstant.canonicalName ?? match.geoTargetConstant.name ?? name),
            });
          }
        }

        const request: Row = {
          language: language.resource,
          geoTargetConstants: geo.map((g) => g.resource),
          includeAdultKeywords: false,
          keywordPlanNetwork: args.network === 'google_search' ? 'GOOGLE_SEARCH' : 'GOOGLE_SEARCH_AND_PARTNERS',
          pageSize: Math.min(1000, args.limit),
        };
        if (args.keywords?.length && args.url) request.keywordAndUrlSeed = { url: args.url, keywords: args.keywords };
        else if (args.keywords?.length) request.keywordSeed = { keywords: args.keywords };
        else request.urlSeed = { url: args.url };

        const response = await ctx.ads.generateKeywordIdeas(s.auth, s.customerId, request, s.login);
        const ideas = ((response.results as Row[] | undefined) ?? [])
          .map((idea) => {
            const m = (idea.keywordIdeaMetrics ?? {}) as Row;
            const volumes = ((m.monthlySearchVolumes as Row[] | undefined) ?? [])
              .map((v) => ({ key: num(v.year) * 100 + MONTHS.indexOf(String(v.month)) + 1, searches: num(v.monthlySearches) }))
              .sort((a, b) => a.key - b.key);
            return [
              idea.text ?? null,
              m.avgMonthlySearches === undefined ? null : num(m.avgMonthlySearches),
              m.competition ?? null,
              m.competitionIndex === undefined ? null : num(m.competitionIndex),
              m.lowTopOfPageBidMicros === undefined ? null : money(m.lowTopOfPageBidMicros),
              m.highTopOfPageBidMicros === undefined ? null : money(m.highTopOfPageBidMicros),
              volumes.slice(-3).map((v) => v.searches),
            ] as unknown[];
          })
          .sort((a, b) => num(b[1]) - num(a[1]))
          .slice(0, args.limit);
        return ok({
          customer_id: s.header(account).customer_id,
          currency: account.currency,
          language: language.name,
          locations: geo.length ? geo.map((g) => ({ input: g.input, resolved: g.name, id: g.resource.split('/')[1] })) : 'all locations',
          network: request.keywordPlanNetwork,
          columns: ['keyword', 'avg_monthly_searches', 'competition', 'competition_index', 'low_top_of_page_bid', 'high_top_of_page_bid', 'last_3_months_searches'],
          rows: ideas,
          notes: [
            'Bids are in the account currency. competition_index runs 0-100.',
            'Keyword Planner volumes are rounded ranges; treat them as relative, not exact.',
          ],
        });
      }),
  );
};
