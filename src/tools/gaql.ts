import * as z from 'zod';
import { withLimit } from '../ads/queries.js';
import { flattenRow, toTable } from '../ads/format.js';
import type { Row } from '../ads/client.js';
import { authFrom, customerArgs, limitArg, ok, openSession, READ_ONLY, runTool, ToolInputError, type ToolRegistrar } from './shared.js';

export const registerGaqlTools: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    'run_gaql_query',
    {
      title: 'Run a GAQL query',
      description:
        'Runs any read-only Google Ads Query Language (GAQL) SELECT query against one account and returns flattened rows. ' +
        'Use it for anything the other tools do not cover. Fields ending in _micros are converted to currency units and renamed ' +
        'without the suffix. Check field names and compatibility with describe_resource first. Example: ' +
        "SELECT campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS ORDER BY metrics.clicks DESC",
      inputSchema: {
        ...customerArgs,
        query: z.string().min(10).max(20000).describe('GAQL SELECT query. A LIMIT is added when missing.'),
        limit: limitArg(200, 1000),
      },
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      runTool(ctx, 'run_gaql_query', extra, async () => {
        const query = args.query.trim();
        if (!/^select\s/i.test(query)) throw new ToolInputError('Only SELECT queries are supported; GAQL cannot modify an account.');
        const s = await openSession(ctx, extra, args);
        const account = await s.account();
        const result = await s.search(withLimit(query, args.limit + 1), args.limit + 1);
        const truncated = result.truncated || result.rows.length > args.limit;
        const keepResourceNames = /resource_name/i.test(query);
        const table = toTable(result.rows.slice(0, args.limit).map((row) => flattenRow(row, keepResourceNames)));
        return ok({
          ...s.header(account),
          api_version: ctx.ads.apiVersion,
          columns: table.columns,
          rows: table.rows,
          row_count: table.rows.length,
          truncated,
          notes: [
            '*_micros fields were converted to currency units and renamed without _micros.',
            'Metrics whose value is zero may be omitted by the API; treat missing metrics as 0.',
          ],
        });
      }),
  );

  server.registerTool(
    'describe_resource',
    {
      title: 'Describe a GAQL resource',
      description:
        'GAQL metadata for one resource (e.g. campaign, ad_group, keyword_view, search_term_view, asset_group): its fields with ' +
        'types and enum values, the resources it can join, and every segment and metric allowed when it is in the FROM clause.',
      inputSchema: {
        resource: z.string().regex(/^[a-z][a-z0-9_]*$/, 'Use a resource name like campaign').describe('Resource name, e.g. campaign.'),
        filter: z.string().max(60).optional().describe('Only names containing this text, e.g. "impression_share" or "status".'),
        include: z.enum(['all', 'fields', 'segments', 'metrics']).default('all'),
      },
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      runTool(ctx, 'describe_resource', extra, async () => {
        const auth = authFrom(extra);
        const [resources, fields] = await Promise.all([
          ctx.ads.searchFields(
            auth,
            `SELECT name, category, attribute_resources, metrics, segments WHERE name = '${args.resource}'`,
          ),
          args.include === 'all' || args.include === 'fields'
            ? ctx.ads.searchFields(
                auth,
                `SELECT name, data_type, selectable, filterable, sortable, is_repeated, enum_values WHERE name LIKE '${args.resource}.%'`,
              )
            : Promise.resolve([] as Row[]),
        ]);
        const resource = resources[0];
        if (!resource || resource.category !== 'RESOURCE') {
          throw new ToolInputError(`"${args.resource}" is not a GAQL resource. Examples: campaign, ad_group, keyword_view, search_term_view.`);
        }
        const needle = args.filter?.toLowerCase();
        const keep = (name: string) => !needle || name.toLowerCase().includes(needle);
        const names = (list: unknown) => ((list as string[] | undefined) ?? []).filter(keep).sort();
        const fieldRows = fields
          .filter((f) => keep(String(f.name ?? '')))
          .sort((a, b) => String(a.name).localeCompare(String(b.name)))
          .map((f) => {
            const enums = (f.enumValues as string[] | undefined) ?? [];
            return [
              f.name ?? null,
              f.dataType ?? null,
              f.selectable === true,
              f.filterable === true,
              f.sortable === true,
              f.isRepeated === true,
              enums.length ? enums.slice(0, 30).join(', ') + (enums.length > 30 ? ', ...' : '') : null,
            ];
          });
        return ok({
          resource: args.resource,
          api_version: ctx.ads.apiVersion,
          joinable_resources: names(resource.attributeResources),
          ...(args.include === 'all' || args.include === 'fields'
            ? { fields: { columns: ['name', 'type', 'selectable', 'filterable', 'sortable', 'repeated', 'enum_values'], rows: fieldRows } }
            : {}),
          ...(args.include === 'all' || args.include === 'segments' ? { segments: names(resource.segments) } : {}),
          ...(args.include === 'all' || args.include === 'metrics' ? { metrics: names(resource.metrics) } : {}),
          notes: [
            'Fields of joinable_resources can be selected too (they do not segment metrics).',
            'A segment in WHERE must also be in SELECT, except segments.date and other core date segments.',
          ],
        });
      }),
  );
};
