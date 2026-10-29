/**
 * Checks every built-in GAQL query against Google's published field reference
 * for an API version, without needing credentials. Run it before changing
 * GOOGLE_ADS_API_VERSION:
 *
 *   npm run check:gaql            # checks the default version (v26)
 *   npm run check:gaql -- v27     # checks a newer version
 *
 * For each query it verifies that every selected field is selectable when the
 * FROM resource is used, that WHERE fields are filterable and ORDER BY fields
 * sortable. Reference pages are cached under the OS temp directory.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BREAKDOWN_DIMENSIONS, Q, type GaqlSpec } from '../src/ads/queries.js';

const version = (process.argv[2] ?? 'v26').toLowerCase();
if (!/^v\d+$/.test(version)) {
  console.error('Usage: npm run check:gaql -- v27');
  process.exit(2);
}

interface Page {
  own: Set<string>;
  usable: Set<string>;
  joinable: Set<string>;
  body: string;
}

const cacheDir = path.join(tmpdir(), 'google-ads-fieldref', version);
const pages = new Map<string, Page>();

const decode = (s: string) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

async function load(resource: string): Promise<Page | null> {
  if (pages.has(resource)) return pages.get(resource)!;
  const file = path.join(cacheDir, `${resource}.html`);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    const res = await fetch(`https://developers.google.com/google-ads/api/fields/${version}/${resource}`, {
      headers: { 'user-agent': 'Mozilla/5.0 (google-ads-mcp check-gaql)' },
    });
    if (!res.ok) return null;
    raw = await res.text();
    await mkdir(cacheDir, { recursive: true });
    await writeFile(file, raw);
  }
  const start = raw.indexOf('<article');
  const body = start >= 0 ? raw.slice(start) : raw;
  const own = new Set<string>();
  for (const m of body.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)) {
    const text = decode(m[1]!);
    if (text.startsWith(`${resource}.`)) own.add(text);
  }
  const usable = new Set<string>();
  for (const m of body.matchAll(/#((?:segments|metrics)\.[a-z_.]+)">[a-z_.]+<!-- ([^>]*?) -->/g)) {
    if (m[2]!.trim() === 'Yes, it is') usable.add(m[1]!);
  }
  const joinable = new Set<string>();
  for (const title of ['Attributed resources', 'Segmenting resources']) {
    const index = body.indexOf(title);
    if (index < 0) continue;
    const chunk = body.slice(index + title.length, index + 6000);
    const stop = chunk.indexOf('Fields from the above resources');
    for (const word of decode(chunk.slice(0, stop > 0 ? stop : 2000)).match(/\b[a-z][a-z_]+\b/g) ?? []) joinable.add(word);
  }
  const page = { own, usable, joinable, body };
  pages.set(resource, page);
  return page;
}

/** Reads "Filterable"/"Sortable" for one field from the page section that documents it. */
function attribute(page: Page, field: string, name: 'Filterable' | 'Sortable'): boolean | null {
  const heading = new RegExp(`<h2[^>]*>\\s*(?:<[^>]+>\\s*)*${field.replace(/\./g, '\\.')}\\s*(?:<[^>]+>\\s*)*</h2>([\\s\\S]*?)(?=<h2)`);
  const section = heading.exec(page.body)?.[1];
  if (!section) return null;
  const value = new RegExp(`${name}\\s+(True|False)`).exec(decode(section))?.[1];
  return value === undefined ? null : value === 'True';
}

const fieldsIn = (clause: string): string[] =>
  clause.replace(/'[^']*'/g, '').match(/\b[a-z][a-z_]*(?:\.[a-z][a-z_]*)+\b/g) ?? [];

const range = { start: '2026-10-01', end: '2026-10-07', label: 'custom', days: 7 };
const specs: [string, GaqlSpec][] = [
  ['customerBasics', Q.customerBasics()],
  ['customerSettings', Q.customerSettings()],
  ['customerClients', Q.customerClients()],
  ['accountTotals', Q.accountTotals(range)],
  ['campaignInventory', Q.campaignInventory()],
  ...(['day', 'week', 'month'] as const).flatMap((g): [string, GaqlSpec][] => [
    [`trend ${g}`, Q.trend(range, g)],
    [`trend ${g} (campaign)`, Q.trend(range, g, '1')],
  ]),
  ['campaigns', Q.campaigns(range, { channelTypes: ['SEARCH'], campaignId: '1', limit: 10 })],
  ['campaignMetrics', Q.campaignMetrics(range)],
  ['adGroups', Q.adGroups(range, { campaignId: '1', limit: 10 })],
  ['keywords', Q.keywords(range, { campaignId: '1', adGroupId: '2', only: 'no_conversions', limit: 10 })],
  ['searchTerms', Q.searchTerms(range, { campaignId: '1', adGroupId: '2', only: 'converting', minClicks: 2, limit: 10 })],
  ['ads', Q.ads(range, { campaignId: '1', adGroupId: '2', limit: 10 })],
  ['adPolicyIssues', Q.adPolicyIssues({ campaignId: '1', adGroupId: '2', limit: 10 })],
  ['assetGroups', Q.assetGroups(range, { campaignId: '1', limit: 10 })],
  ...BREAKDOWN_DIMENSIONS.flatMap((d): [string, GaqlSpec][] => [
    [`breakdown ${d}`, Q.breakdown(d, range)],
    [`breakdown ${d} (campaign)`, Q.breakdown(d, range, '1')],
  ]),
  ['geoTargetNames', Q.geoTargetNames(['1007740'])],
  ['languageByCode', Q.languageByCode('en')],
  ['budgetCampaigns', Q.budgetCampaigns()],
  ['campaignSpend', Q.campaignSpend(range)],
  ['conversionActions', Q.conversionActions()],
  ['conversionsByAction', Q.conversionsByAction(range)],
  ['campaignNegatives', Q.campaignNegatives({ campaignId: '1', limit: 10 })],
  ['adGroupNegatives', Q.adGroupNegatives({ campaignId: '1', limit: 10 })],
  ['sharedNegatives', Q.sharedNegatives(10)],
  ['sharedNegativeLinks', Q.sharedNegativeLinks()],
  ['recommendations', Q.recommendations({ types: ['KEYWORD'], limit: 10 })],
  ['campaignNames', Q.campaignNames()],
  ['adGroupNames', Q.adGroupNames(['1'])],
  ['changeEvents', Q.changeEvents('2026-10-01 00:00:00', '2026-10-07 23:59:59', 10)],
];

async function check(spec: GaqlSpec): Promise<string[]> {
  const from = await load(spec.from);
  if (!from) return [`resource ${spec.from} has no reference page in ${version}`];
  const problems: string[] = [];
  const pageFor = async (field: string): Promise<Page | null> => {
    const top = field.split('.')[0]!;
    if (top === 'segments' || top === 'metrics' || top === spec.from) return from;
    return load(top);
  };
  const selectable = async (field: string): Promise<boolean> => {
    const top = field.split('.')[0]!;
    if (top === spec.from) return from.own.has(field);
    if (top === 'segments' || top === 'metrics') return from.usable.has(field);
    if (!from.joinable.has(top)) return false;
    return (await load(top))?.own.has(field) ?? false;
  };
  for (const field of spec.select) {
    if (!(await selectable(field))) problems.push(`not selectable: ${field}`);
  }
  for (const clause of (spec.where ?? []).filter((w): w is string => Boolean(w))) {
    for (const field of fieldsIn(clause)) {
      if (!(await selectable(field))) problems.push(`WHERE field not available: ${field}`);
      else {
        const page = await pageFor(field);
        if (page && attribute(page, field, 'Filterable') === false) problems.push(`not filterable: ${field}`);
      }
    }
  }
  for (const field of fieldsIn(spec.orderBy ?? '')) {
    const page = await pageFor(field);
    if (page && attribute(page, field, 'Sortable') === false) problems.push(`not sortable: ${field}`);
  }
  return problems;
}

let failures = 0;
console.log(`Checking ${specs.length} built-in queries against the ${version} field reference (cache: ${cacheDir})`);
for (const [name, spec] of specs) {
  const problems = await check(spec);
  if (problems.length) failures++;
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${name.padEnd(28)} FROM ${spec.from}${problems.length ? `\n       ${problems.join('\n       ')}` : ''}`);
}
console.log(failures ? `\n${failures} query(ies) need changes before using ${version}.` : `\nAll queries are valid for ${version}.`);
process.exit(failures ? 1 : 0);
