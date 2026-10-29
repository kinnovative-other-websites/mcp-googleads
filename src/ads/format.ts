/**
 * Number handling and output shaping. Tools return compact JSON:
 * { ...context, columns: [...], rows: [[...], ...] } so large tables stay cheap
 * in Claude's context, with money already converted from micros.
 */
import type { Row } from './client.js';

export const round = (value: number, digits = 2): number => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

/** int64 values arrive as strings, doubles as numbers, and zero values may be absent. */
export const num = (value: unknown): number => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
};

export const optionalNum = (value: unknown): number | null => (value === undefined || value === null || value === '' ? null : num(value));

/** Micros (1/1,000,000 of the account currency) to currency units. */
export const money = (micros: unknown): number => round(num(micros) / 1_000_000, 2);

export const optionalMoney = (micros: unknown): number | null => (micros === undefined || micros === null ? null : money(micros));

/** API fractions (0.4231) to percentages (42.31). */
export const percent = (fraction: unknown): number | null =>
  fraction === undefined || fraction === null ? null : round(num(fraction) * 100, 2);

export const ratio = (a: number, b: number, scale = 1, digits = 2): number | null => (b > 0 ? round((a / b) * scale, digits) : null);

export const changePct = (current: number, previous: number): number | null =>
  previous > 0 ? round(((current - previous) / previous) * 100, 1) : current > 0 ? null : 0;

export interface BaseMetrics {
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  conv_value: number;
}

export const emptyMetrics = (): BaseMetrics => ({ impressions: 0, clicks: 0, cost: 0, conversions: 0, conv_value: 0 });

export function readMetrics(row: Row): BaseMetrics {
  const m = (row.metrics ?? {}) as Row;
  return {
    impressions: num(m.impressions),
    clicks: num(m.clicks),
    cost: money(m.costMicros),
    conversions: round(num(m.conversions), 2),
    conv_value: round(num(m.conversionsValue), 2),
  };
}

export function addMetrics(into: BaseMetrics, add: BaseMetrics): BaseMetrics {
  into.impressions += add.impressions;
  into.clicks += add.clicks;
  into.cost = round(into.cost + add.cost, 2);
  into.conversions = round(into.conversions + add.conversions, 2);
  into.conv_value = round(into.conv_value + add.conv_value, 2);
  return into;
}

export interface DerivedMetrics {
  ctr: number | null;
  avg_cpc: number | null;
  conv_rate: number | null;
  cpa: number | null;
  roas: number | null;
}

/** Ratios computed from totals, so they stay correct after aggregation. */
export function derive(m: BaseMetrics): DerivedMetrics {
  return {
    ctr: ratio(m.clicks, m.impressions, 100),
    avg_cpc: ratio(m.cost, m.clicks),
    conv_rate: ratio(m.conversions, m.clicks, 100),
    cpa: ratio(m.cost, m.conversions),
    roas: ratio(m.conv_value, m.cost),
  };
}

export const METRIC_COLUMNS = ['impressions', 'clicks', 'cost', 'conversions', 'conv_value', 'ctr', 'avg_cpc', 'conv_rate', 'cpa', 'roas'] as const;

export function metricCells(m: BaseMetrics): (number | null)[] {
  const d = derive(m);
  return [m.impressions, m.clicks, m.cost, m.conversions, m.conv_value, d.ctr, d.avg_cpc, d.conv_rate, d.cpa, d.roas];
}

export const METRIC_NOTE =
  'cost, avg_cpc, cpa and conv_value are in the account currency; ctr and conv_rate are percentages; ' +
  'roas = conv_value / cost; null means not computable (zero denominator).';

/** Formats 1234567890 as 123-456-7890, the way the Google Ads UI shows IDs. */
export const dashed = (id: string | number | undefined): string => {
  const s = String(id ?? '');
  return /^\d{10}$/.test(s) ? `${s.slice(0, 3)}-${s.slice(3, 6)}-${s.slice(6)}` : s;
};

/** Writes a keyword the way Google Ads shows match types: [exact], "phrase", broad. */
export function keywordNotation(text: string | undefined, matchType: string | undefined): string {
  const t = text ?? '';
  if (matchType === 'EXACT') return `[${t}]`;
  if (matchType === 'PHRASE') return `"${t}"`;
  return t;
}

const camelToSnake = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * Flattens a REST row into GAQL-style dotted snake_case keys.
 * `*_micros` fields are converted to currency units and renamed without the suffix.
 * Arrays of scalars stay arrays; arrays of objects are kept as compact objects.
 */
export function flattenRow(row: Row, keepResourceNames: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (value: unknown, path: string) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value as Row)) walk(v, path ? `${path}.${camelToSnake(k)}` : camelToSnake(k));
      return;
    }
    const leaf = path.split('.').pop() ?? path;
    if (!keepResourceNames && leaf === 'resource_name') return;
    if (leaf.endsWith('_micros') && (typeof value === 'string' || typeof value === 'number')) {
      out[path.slice(0, -'_micros'.length)] = money(value);
      return;
    }
    if (typeof value === 'string' && /^-?\d{1,15}$/.test(value) && !leaf.endsWith('_id') && leaf !== 'id') {
      out[path] = Number(value);
      return;
    }
    out[path] = value;
  };
  walk(row, '');
  return out;
}

/** Turns a list of flat records into columns + rows, keeping first-seen column order. */
export function toTable(records: Record<string, unknown>[]): { columns: string[]; rows: unknown[][] } {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return { columns, rows: records.map((r) => columns.map((c) => (r[c] === undefined ? null : r[c]))) };
}
