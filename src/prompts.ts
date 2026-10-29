/**
 * Ready-made analysis prompts, shown in Claude's prompt/attachment menu for this connector.
 */
import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const accountArg = {
  customer_id: z.string().optional().describe('Google Ads account ID (leave empty to pick one)'),
};

const forAccount = (customerId?: string) =>
  customerId ? `Use Google Ads account ${customerId}.` : 'If more than one account is available, call list_accounts and ask me which one to use.';

const READ_ONLY_REMINDER =
  'This connection is read-only: do not claim to have changed anything. For every recommendation, give the exact steps ' +
  'to apply it in the Google Ads web interface, and say how to measure whether it worked.';

const text = (body: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text: body } }] });

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'account_audit',
    {
      title: 'Full account audit',
      description: 'Structured audit of one account with prioritized fixes.',
      argsSchema: {
        ...accountArg,
        date_range: z.string().optional().describe('e.g. last_30_days (default) or last_90_days'),
      },
    },
    ({ customer_id, date_range }) =>
      text(
        [
          `Audit my Google Ads account. ${forAccount(customer_id)} Period: ${date_range || 'last_30_days'}.`,
          'Work through these steps with the Google Ads tools:',
          '1. get_account_overview (with comparison) for the headline trend.',
          '2. get_campaign_performance with compare=true: find campaigns limited by budget vs rank, weak CPA/ROAS, and odd statuses.',
          '3. get_budget_pacing for over/under-spend this month.',
          '4. get_conversion_setup: is conversion tracking trustworthy (primary actions, counting, zero-conversion actions)?',
          '5. get_search_terms with only=no_conversions and get_negative_keywords: wasted spend and missing negatives.',
          '6. get_keyword_performance with max_quality_score=5: Quality Score problems and their weakest component.',
          '7. get_ads with policy_issues_only=true, then get_ads for ad strength and copy gaps.',
          '8. get_breakdown by device and by hour_of_day for clear outliers.',
          '9. get_change_history for recent changes that explain shifts; get_recommendations for Google ideas worth taking.',
          'Then write: a 5-line executive summary; the top 10 issues ranked by estimated monthly impact (money wasted or ' +
            'conversions missed), each with evidence numbers; and a prioritized action plan (quick wins this week, then ' +
            'structural changes).',
          READ_ONLY_REMINDER,
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'wasted_spend_review',
    {
      title: 'Find wasted spend',
      description: 'Search terms and keywords that cost money without converting, with ready-to-add negative keywords.',
      argsSchema: {
        ...accountArg,
        date_range: z.string().optional().describe('e.g. last_30_days (default) or last_90_days'),
      },
    },
    ({ customer_id, date_range }) =>
      text(
        [
          `Find wasted spend in my Google Ads account. ${forAccount(customer_id)} Period: ${date_range || 'last_30_days'}.`,
          '1. get_search_terms with only=no_conversions (limit 300) and get_keyword_performance with only=no_conversions.',
          '2. get_negative_keywords so you do not suggest negatives that already exist.',
          '3. get_search_terms with only=converting, so you never block a term that converts elsewhere.',
          'Group the waste into themes (irrelevant intent, jobs, free, competitors, wrong location, etc.).',
          'Output: total wasted cost; a table of proposed negatives with match type in Google notation ([exact], "phrase", broad), ' +
            'the level to add them (campaign, ad group, or a shared list) and the cost each would have saved; and keywords to ' +
            'pause or rework, with reasons.',
          READ_ONLY_REMINDER,
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'weekly_report',
    {
      title: 'Weekly performance report',
      description: 'Last 7 days versus the 7 days before, ready to share with the team.',
      argsSchema: accountArg,
    },
    ({ customer_id }) =>
      text(
        [
          `Write this week's Google Ads report. ${forAccount(customer_id)}`,
          'Use get_account_overview (date_range=last_7_days, compare=true), get_campaign_performance (date_range=last_7_days, ' +
            'compare=true), get_performance_trend (date_range=last_14_days) and get_change_history (days=14).',
          'Structure: headline numbers with week-over-week change; what went well; what went badly and the likely cause ' +
            '(link to changes made); top 3 actions for next week with owners left blank.',
          'Keep it under 300 words, plain language, numbers in the account currency.',
          READ_ONLY_REMINDER,
        ].join('\n'),
      ),
  );
}
