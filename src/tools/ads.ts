import * as z from 'zod';
import { Q } from '../ads/queries.js';
import { METRIC_COLUMNS, METRIC_NOTE, metricCells, readMetrics } from '../ads/format.js';
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

const assetTexts = (assets: unknown): string[] =>
  Array.isArray(assets)
    ? (assets as Row[]).map((a) => `${a.text ?? ''}${a.pinnedField ? ` [pinned ${a.pinnedField}]` : ''}`)
    : [];

export const registerAdTools: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    'get_ads',
    {
      title: 'Ads and ad copy',
      description:
        'Ads with their copy (responsive search ad headlines and descriptions, with pins), final URL, ad strength, approval ' +
        'status and policy topics, plus metrics. Set policy_issues_only to list disapproved or limited ads regardless of traffic.',
      inputSchema: {
        ...customerArgs,
        ...dateArgs,
        campaign_id: idFilter('campaign'),
        ad_group_id: idFilter('ad group'),
        status: statusArg,
        policy_issues_only: z
          .boolean()
          .default(false)
          .describe('Only ads that are disapproved, approved (limited) or limited by location policy. Ignores dates and metrics.'),
        order_by: orderArg,
        limit: limitArg(50, 500),
      },
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      runTool(ctx, 'get_ads', extra, async () => {
        const s = await openSession(ctx, extra, args);
        const account = await s.clientAccount();
        const policyOnly = args.policy_issues_only;
        const range = policyOnly ? undefined : s.range(args, account);
        const { rows, truncated } = policyOnly
          ? await s.rows(Q.adPolicyIssues({ campaignId: args.campaign_id, adGroupId: args.ad_group_id, limit: args.limit }), args.limit)
          : await s.rows(
              Q.ads(range!, {
                status: args.status,
                campaignId: args.campaign_id,
                adGroupId: args.ad_group_id,
                order: args.order_by,
                limit: args.limit,
              }),
              args.limit,
            );
        const columns = [
          'campaign_id',
          'campaign',
          'ad_group_id',
          'ad_group',
          'ad_id',
          'type',
          'status',
          'primary_status',
          'primary_status_reasons',
          'ad_strength',
          'approval_status',
          'review_status',
          'policy_topics',
          'final_url',
          'headlines',
          'descriptions',
          ...(policyOnly ? [] : METRIC_COLUMNS),
        ];
        return ok({
          ...s.header(account, range),
          columns,
          rows: rows.map((row) => {
            const a = (row.adGroupAd ?? {}) as Row;
            const ad = (a.ad ?? {}) as Row;
            const policy = (a.policySummary ?? {}) as Row;
            const topics = ((policy.policyTopicEntries as Row[] | undefined) ?? []).map((p) => `${p.topic ?? '?'} (${p.type ?? '?'})`);
            return [
              String(row.campaign?.id ?? ''),
              row.campaign?.name ?? null,
              String(row.adGroup?.id ?? ''),
              row.adGroup?.name ?? null,
              String(ad.id ?? ''),
              ad.type ?? null,
              a.status ?? null,
              a.primaryStatus ?? null,
              joinList(a.primaryStatusReasons),
              a.adStrength ?? null,
              policy.approvalStatus ?? null,
              policy.reviewStatus ?? null,
              topics.length ? topics.join('; ') : null,
              (ad.finalUrls as string[] | undefined)?.[0] ?? null,
              assetTexts(ad.responsiveSearchAd?.headlines),
              assetTexts(ad.responsiveSearchAd?.descriptions),
              ...(policyOnly ? [] : metricCells(readMetrics(row))),
            ];
          }),
          truncated,
          notes: [
            ...(policyOnly ? ['Policy view: every non-removed ad with a policy issue, with or without traffic.'] : [METRIC_NOTE]),
            'Headlines and descriptions are filled for responsive search ads; other ad types show type and status only.',
            'Responsive search ads allow up to 15 headlines (30 characters) and 4 descriptions (90 characters).',
          ],
        });
      }),
  );
};
