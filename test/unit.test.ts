import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ConfigError, loadConfig, normalizeCustomerId } from '../src/config.js';
import { Sealer } from '../src/crypto.js';
import { DateRangeError, previousPeriod, resolveDateRange, todayIn } from '../src/ads/dates.js';
import { changePct, dashed, derive, flattenRow, keywordNotation, toTable } from '../src/ads/format.js';
import { gaql, Q, withLimit } from '../src/ads/queries.js';

// 2026-10-28 20:00 UTC is already 2026-10-29 in India.
const NOW = new Date('2026-10-28T20:00:00Z');
const IST = 'Asia/Kolkata';

describe('dates', () => {
  test('today follows the account time zone', () => {
    assert.equal(todayIn(IST, NOW), '2026-10-29');
    assert.equal(todayIn('America/Los_Angeles', NOW), '2026-10-28');
  });

  test('presets resolve like the Google Ads UI (last N days end yesterday)', () => {
    const r = (date_range: Parameters<typeof resolveDateRange>[0]['date_range']) => resolveDateRange({ date_range }, IST, NOW);
    assert.deepEqual(r('last_7_days'), { start: '2026-10-22', end: '2026-10-28', label: 'last_7_days', days: 7 });
    assert.deepEqual(r('last_30_days'), { start: '2026-09-29', end: '2026-10-28', label: 'last_30_days', days: 30 });
    assert.deepEqual(r('this_month'), { start: '2026-10-01', end: '2026-10-29', label: 'this_month', days: 29 });
    assert.deepEqual(r('last_month'), { start: '2026-09-01', end: '2026-09-30', label: 'last_month', days: 30 });
    assert.deepEqual(r('this_year'), { start: '2026-01-01', end: '2026-10-29', label: 'this_year', days: 302 });
    assert.deepEqual(r('today'), { start: '2026-10-29', end: '2026-10-29', label: 'today', days: 1 });
    assert.deepEqual(resolveDateRange({}, IST, NOW).label, 'last_30_days');
  });

  test('last_month handles year boundaries and short months', () => {
    assert.deepEqual(resolveDateRange({ date_range: 'last_month' }, 'UTC', new Date('2027-01-15T00:00:00Z')), {
      start: '2026-12-01',
      end: '2026-12-31',
      label: 'last_month',
      days: 31,
    });
    assert.equal(resolveDateRange({ date_range: 'last_month' }, 'UTC', new Date('2028-03-02T00:00:00Z')).end, '2028-02-29');
  });

  test('previous period has the same length and ends the day before', () => {
    const range = resolveDateRange({ date_range: 'last_7_days' }, IST, NOW);
    assert.deepEqual(previousPeriod(range), { start: '2026-10-15', end: '2026-10-21', label: 'previous_period', days: 7 });
  });

  test('custom ranges are validated', () => {
    assert.deepEqual(resolveDateRange({ start_date: '2026-10-01', end_date: '2026-10-10' }, IST, NOW).days, 10);
    assert.throws(() => resolveDateRange({ start_date: '2026-10-01' }, IST, NOW), DateRangeError);
    assert.throws(() => resolveDateRange({ start_date: '2026-10-10', end_date: '2026-10-01' }, IST, NOW), DateRangeError);
    assert.throws(() => resolveDateRange({ start_date: '2026-02-30', end_date: '2026-03-01' }, IST, NOW), DateRangeError);
  });
});

describe('format', () => {
  test('flattenRow uses GAQL names, converts micros and keeps IDs as strings', () => {
    const flat = flattenRow(
      {
        campaign: { resourceName: 'customers/1/campaigns/2', id: '2', name: 'Brand' },
        adGroupCriterion: { qualityInfo: { qualityScore: 7 } },
        metrics: { costMicros: '12345678', clicks: '10', ctr: 0.05 },
      },
      false,
    );
    assert.deepEqual(flat, {
      'campaign.id': '2',
      'campaign.name': 'Brand',
      'ad_group_criterion.quality_info.quality_score': 7,
      'metrics.cost': 12.35,
      'metrics.clicks': 10,
      'metrics.ctr': 0.05,
    });
    assert.equal(flattenRow({ campaign: { resourceName: 'x' } }, true)['campaign.resource_name'], 'x');
  });

  test('toTable aligns sparse records', () => {
    assert.deepEqual(toTable([{ a: 1 }, { b: 2 }]), { columns: ['a', 'b'], rows: [[1, null], [null, 2]] });
  });

  test('derived metrics and changes', () => {
    assert.deepEqual(derive({ impressions: 1000, clicks: 50, cost: 100, conversions: 4, conv_value: 400 }), {
      ctr: 5,
      avg_cpc: 2,
      conv_rate: 8,
      cpa: 25,
      roas: 4,
    });
    assert.deepEqual(derive({ impressions: 0, clicks: 0, cost: 0, conversions: 0, conv_value: 0 }), {
      ctr: null,
      avg_cpc: null,
      conv_rate: null,
      cpa: null,
      roas: null,
    });
    assert.equal(changePct(150, 100), 50);
    assert.equal(changePct(0, 0), 0);
    assert.equal(changePct(5, 0), null);
  });

  test('keyword notation and dashed IDs', () => {
    assert.equal(keywordNotation('cbse school', 'EXACT'), '[cbse school]');
    assert.equal(keywordNotation('cbse school', 'PHRASE'), '"cbse school"');
    assert.equal(keywordNotation('cbse school', 'BROAD'), 'cbse school');
    assert.equal(dashed('1234567890'), '123-456-7890');
  });
});

describe('queries', () => {
  const range = { start: '2026-10-01', end: '2026-10-07', label: 'custom', days: 7 };

  test('builders produce GAQL with filters in order', () => {
    assert.equal(
      gaql(Q.campaigns(range, { status: 'enabled', channelTypes: ['SEARCH'], campaignId: '42', order: 'conversions', limit: 10 })).replace(
        /SELECT .+ FROM/,
        'SELECT ... FROM',
      ),
      "SELECT ... FROM campaign WHERE segments.date BETWEEN '2026-10-01' AND '2026-10-07' AND campaign.status = 'ENABLED' " +
        "AND campaign.advertising_channel_type IN ('SEARCH') AND campaign.id = 42 ORDER BY metrics.conversions DESC LIMIT 10",
    );
  });

  test('values that could alter a query are rejected', () => {
    assert.throws(() => gaql(Q.campaigns(range, { channelTypes: ["SEARCH') OR ('1"], limit: 5 })), /Invalid enum/);
    assert.throws(() => gaql(Q.keywords(range, { campaignId: '1 OR 1=1', limit: 5 })), /Invalid ID/);
    assert.throws(() => gaql(Q.languageByCode("en' OR '1")), /Invalid language/);
    assert.throws(() => gaql(Q.changeEvents('2026-10-01', '2026-10-02 00:00:00', 10)), /Invalid date-time/);
  });

  test('withLimit adds a LIMIT only when missing and keeps PARAMETERS last', () => {
    assert.equal(withLimit('SELECT campaign.id FROM campaign', 5), 'SELECT campaign.id FROM campaign LIMIT 5');
    assert.equal(withLimit('SELECT campaign.id FROM campaign LIMIT 3', 5), 'SELECT campaign.id FROM campaign LIMIT 3');
    assert.equal(
      withLimit('SELECT campaign.id FROM campaign PARAMETERS include_drafts=true', 5),
      'SELECT campaign.id FROM campaign LIMIT 5 PARAMETERS include_drafts=true',
    );
  });
});

describe('sealed tokens', () => {
  const sealer = new Sealer('unit-test-secret-'.padEnd(40, 'x'));

  test('round trip, kind binding, tamper and expiry checks', () => {
    const token = sealer.seal('access', { e: 'a@b.c', exp: Math.floor(Date.now() / 1000) + 60 });
    assert.equal(sealer.open<{ e: string }>('access', token)?.e, 'a@b.c');
    assert.equal(sealer.open('refresh', token), null, 'an access token is not a refresh token');
    assert.equal(sealer.open('access', `${token.slice(0, -2)}AA`), null, 'tampering is detected');
    assert.equal(new Sealer('another-secret-'.padEnd(40, 'y')).open('access', token), null, 'other keys cannot open it');
    assert.equal(sealer.open('access', sealer.seal('access', { exp: Math.floor(Date.now() / 1000) - 1 })), null, 'expired');
    assert.equal(sealer.open('access', 'garbage'), null);
  });
});

describe('config', () => {
  const valid = {
    PUBLIC_BASE_URL: 'https://ads-mcp.example.com/',
    GOOGLE_OAUTH_CLIENT_ID: 'id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
    MCP_AUTH_SECRET: 'x'.repeat(40),
    ALLOWED_EMAILS: 'Owner@Example.com',
  };

  test('valid configuration derives URLs and normalizes values', () => {
    const cfg = loadConfig({ ...valid, GOOGLE_ADS_LOGIN_CUSTOMER_ID: '111-222-3333' });
    assert.equal(cfg.mcpUrl, 'https://ads-mcp.example.com/mcp');
    assert.equal(cfg.googleRedirectUri, 'https://ads-mcp.example.com/oauth/google/callback');
    assert.equal(cfg.ads.loginCustomerId, '1112223333');
    assert.equal(cfg.ads.apiVersion, 'v26');
    assert.ok(cfg.allowedEmails.has('owner@example.com'));
  });

  test('every problem is reported at once', () => {
    try {
      loadConfig({ PUBLIC_BASE_URL: 'http://ads.example.com', MCP_AUTH_SECRET: 'short' });
      assert.fail('should throw');
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      for (const fragment of ['https://', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'at least 32', 'ALLOWED_EMAILS']) {
        assert.ok(error.message.includes(fragment), `mentions ${fragment}`);
      }
    }
  });

  test('a path in PUBLIC_BASE_URL is refused; localhost may use http', () => {
    assert.throws(() => loadConfig({ ...valid, PUBLIC_BASE_URL: 'https://example.com/ads' }), /origin only/);
    assert.equal(loadConfig({ ...valid, PUBLIC_BASE_URL: 'http://localhost:8080' }).mcpUrl, 'http://localhost:8080/mcp');
  });

  test('customer IDs', () => {
    assert.equal(normalizeCustomerId('123-456-7890'), '1234567890');
    assert.equal(normalizeCustomerId('123 456 7890'), '1234567890');
    assert.equal(normalizeCustomerId('12345'), null);
  });
});
