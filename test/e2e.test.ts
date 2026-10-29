/**
 * End-to-end: drives the server exactly as Claude does (discovery, dynamic
 * client registration, PKCE authorization through Google sign-in, token
 * exchange, MCP calls, refresh, revocation) against a fake Google.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { CLIENT_ID, CLIENT_SECRET, DIRECT_CLIENT_ID, MANAGED_CLIENT_ID, MANAGER_ID, startFakeGoogle, type FakeGoogle } from './fake-google.js';

const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

let fake: FakeGoogle;
let server: http.Server;
let base: string;
const logs: string[] = [];

before(async () => {
  fake = await startFakeGoogle();
  server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cfg = loadConfig({
    PUBLIC_BASE_URL: base,
    GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    MCP_AUTH_SECRET: 'e2e-secret-'.padEnd(48, 'x'),
    ALLOWED_EMAILS: 'owner@example.edu',
    ALLOWED_EMAIL_DOMAINS: 'partner.example',
    GOOGLE_OAUTH_AUTHORIZE_URL: `${fake.url}/o/oauth2/v2/auth`,
    GOOGLE_OAUTH_TOKEN_URL: `${fake.url}/token`,
    GOOGLE_OAUTH_REVOKE_URL: `${fake.url}/revoke`,
    GOOGLE_ADS_API_BASE_URL: fake.url,
    // An unrelated manager, to exercise the automatic direct-access fallback.
    GOOGLE_ADS_LOGIN_CUSTOMER_ID: '999-000-1111',
    TRUST_PROXY: 'false',
  });
  server.on('request', createApp(cfg, { log: (m) => logs.push(m) }));
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fake.close();
});

// ------------------------------------------------------------------ helpers

async function register(redirectUri = CLAUDE_CALLBACK, method = 'client_secret_post') {
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

interface SignIn {
  verifier: string;
  callbackStatus: number;
  location: string | null;
  html: string;
  code?: string;
  state?: string;
}

async function signIn(client: Record<string, any>, opts: { sendCookie?: boolean } = {}): Promise<SignIn> {
  const verifier = randomBytes(32).toString('base64url');
  const url = new URL(`${base}/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'claude-state-123',
    scope: 'ads.read',
    resource: `${base}/mcp`,
  }).toString();
  const toGoogle = await fetch(url, { redirect: 'manual' });
  assert.equal(toGoogle.status, 302, 'authorize redirects to Google');
  const googleUrl = toGoogle.headers.get('location')!;
  assert.ok(googleUrl.startsWith(`${fake.url}/o/oauth2/v2/auth`), 'goes to the Google authorize endpoint');
  const googleParams = new URL(googleUrl).searchParams;
  assert.equal(googleParams.get('access_type'), 'offline');
  assert.equal(googleParams.get('redirect_uri'), `${base}/oauth/google/callback`);
  assert.ok(googleParams.get('scope')!.includes('https://www.googleapis.com/auth/adwords'));
  const cookie = toGoogle.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  assert.ok(cookie.includes('gads_oauth_'), 'sets the login-CSRF cookie');

  const fromGoogle = await fetch(googleUrl, { redirect: 'manual' });
  assert.equal(fromGoogle.status, 302);
  const callback = await fetch(fromGoogle.headers.get('location')!, {
    redirect: 'manual',
    headers: opts.sendCookie === false ? {} : { cookie },
  });
  const location = callback.headers.get('location');
  const result: SignIn = { verifier, callbackStatus: callback.status, location, html: await callback.text() };
  if (location?.startsWith(CLAUDE_CALLBACK)) {
    const params = new URL(location).searchParams;
    result.code = params.get('code') ?? undefined;
    result.state = params.get('state') ?? undefined;
  }
  return result;
}

async function token(params: Record<string, string>) {
  const res = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function connect(accessToken: string): Promise<Client> {
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }),
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = ((res.content as { text?: string }[])[0]?.text ?? '') as string;
  return { isError: res.isError === true, text, json: res.isError ? undefined : (JSON.parse(text) as Record<string, any>) };
}

/** Registers, signs in as `email` and returns tokens. */
async function fullSignIn(email = 'owner@example.edu') {
  fake.email = email;
  const { body: client } = await register();
  const flow = await signIn(client);
  assert.equal(flow.callbackStatus, 302, flow.html);
  const { status, body } = await token({
    grant_type: 'authorization_code',
    code: flow.code!,
    code_verifier: flow.verifier,
    redirect_uri: CLAUDE_CALLBACK,
    client_id: client.client_id,
    client_secret: client.client_secret,
    resource: `${base}/mcp`,
  });
  assert.equal(status, 200, JSON.stringify(body));
  return { client, tokens: body };
}

// -------------------------------------------------------------------- tests

describe('discovery', () => {
  test('unauthenticated MCP requests get 401 pointing at protected-resource metadata', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') ?? '', new RegExp(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`));
  });

  test('protected-resource and authorization-server metadata are published', async () => {
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const prm = (await (await fetch(`${base}${path}`)).json()) as Record<string, any>;
      assert.equal(prm.resource, `${base}/mcp`);
      assert.deepEqual(prm.authorization_servers, [`${base}/`]);
    }
    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, any>;
    assert.equal(as.authorization_endpoint, `${base}/authorize`);
    assert.equal(as.token_endpoint, `${base}/token`);
    assert.equal(as.registration_endpoint, `${base}/register`);
    assert.equal(as.revocation_endpoint, `${base}/revoke`);
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  });

  test('health check and landing page respond', async () => {
    const health = (await (await fetch(`${base}/healthz`)).json()) as Record<string, any>;
    assert.equal(health.ok, true);
    assert.equal(health.ads_api, 'v26');
    const home = await fetch(`${base}/`);
    assert.match(await home.text(), /Add custom connector/);
  });
});

describe('client registration', () => {
  test('Claude, claude.com and loopback redirect URIs are accepted; secrets never expire', async () => {
    const claude = await register();
    assert.equal(claude.status, 201);
    assert.ok(String(claude.body.client_id).startsWith('gadsc_'));
    assert.ok(claude.body.client_secret);
    assert.equal(claude.body.client_secret_expires_at, 0);
    assert.equal((await register('https://claude.com/api/mcp/auth_callback')).status, 201);
    const local = await register('http://localhost:33418/callback', 'none');
    assert.equal(local.status, 201);
    assert.equal(local.body.client_secret, undefined);
  });

  test('other redirect URIs are refused', async () => {
    const res = await register('https://evil.example/callback');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_client_metadata');
  });
});

describe('sign-in', () => {
  test('full flow returns sealed tokens bound to the MCP resource', async () => {
    const { tokens } = await fullSignIn();
    assert.ok(String(tokens.access_token).startsWith('gadst_'));
    assert.ok(String(tokens.refresh_token).startsWith('gadsr_'));
    assert.equal(tokens.token_type, 'Bearer');
    assert.equal(tokens.scope, 'ads.read');
    assert.ok(tokens.expires_in > 3000 && tokens.expires_in <= 3600);
  });

  test('state is returned to Claude unchanged', async () => {
    fake.email = 'owner@example.edu';
    const { body: client } = await register();
    const flow = await signIn(client);
    assert.equal(flow.state, 'claude-state-123');
  });

  test('an authorization code works once, and only with the right PKCE verifier', async () => {
    fake.email = 'owner@example.edu';
    const { body: client } = await register();
    const flow = await signIn(client);
    const params = {
      grant_type: 'authorization_code',
      code: flow.code!,
      redirect_uri: CLAUDE_CALLBACK,
      client_id: client.client_id,
      client_secret: client.client_secret,
    };
    const wrong = await token({ ...params, code_verifier: randomBytes(32).toString('base64url') });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, 'invalid_grant');
    assert.equal((await token({ ...params, code_verifier: flow.verifier })).status, 200);
    const replay = await token({ ...params, code_verifier: flow.verifier });
    assert.equal(replay.status, 400);
    assert.match(replay.body.error_description, /already been used/);
  });

  test('a code cannot be redeemed by another client or with a wrong client secret', async () => {
    fake.email = 'owner@example.edu';
    const { body: client } = await register();
    const { body: other } = await register();
    const flow = await signIn(client);
    const base_ = { grant_type: 'authorization_code', code: flow.code!, code_verifier: flow.verifier, redirect_uri: CLAUDE_CALLBACK };
    const stolen = await token({ ...base_, client_id: other.client_id, client_secret: other.client_secret });
    assert.equal(stolen.status, 400);
    const badSecret = await token({ ...base_, client_id: client.client_id, client_secret: 'nope' });
    assert.equal(badSecret.status, 400);
    assert.equal(badSecret.body.error, 'invalid_client');
  });

  test('HTTP Basic client authentication is accepted at the token endpoint', async () => {
    fake.email = 'owner@example.edu';
    const { body: client } = await register();
    const flow = await signIn(client);
    const res = await fetch(`${base}/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: flow.code!, code_verifier: flow.verifier, redirect_uri: CLAUDE_CALLBACK }),
    });
    assert.equal(res.status, 200);
  });

  test('accounts outside the allowlist are turned away, and their Google grant is revoked', async () => {
    fake.email = 'intruder@other.example';
    const { body: client } = await register();
    const flow = await signIn(client);
    assert.equal(flow.callbackStatus, 403);
    assert.match(flow.html, /not on this server&#39;s allowlist|not on this server's allowlist/);
    assert.match(flow.html, /Return to Claude/);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok([...fake.revoked].some((t) => t.startsWith('g-rt-')));
  });

  test('allowed domains let any account in that domain sign in', async () => {
    const { tokens } = await fullSignIn('analyst@partner.example');
    assert.ok(tokens.access_token);
  });

  test('declining the Google Ads permission is explained', async () => {
    fake.email = 'owner@example.edu';
    fake.grantAdwords = false;
    try {
      const { body: client } = await register();
      const flow = await signIn(client);
      assert.equal(flow.callbackStatus, 403);
      assert.match(flow.html, /Google Ads permission was not granted/);
    } finally {
      fake.grantAdwords = true;
    }
  });

  test('the Google callback refuses a browser without the sign-in cookie', async () => {
    fake.email = 'owner@example.edu';
    const { body: client } = await register();
    const flow = await signIn(client, { sendCookie: false });
    assert.equal(flow.callbackStatus, 400);
    assert.match(flow.html, /Sign-in session not found/);
  });

  test('a tampered access token is rejected', async () => {
    const { tokens } = await fullSignIn();
    const tampered = `${tokens.access_token.slice(0, -4)}AAAA`;
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tampered}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 401);
  });

  test('refresh issues working tokens; revocation ends the Google grant', async () => {
    const { client, tokens } = await fullSignIn();
    const refreshed = await token({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
      client_secret: client.client_secret,
    });
    assert.equal(refreshed.status, 200);
    const mcp = await connect(refreshed.body.access_token);
    assert.equal((await call(mcp, 'get_account_overview', { customer_id: DIRECT_CLIENT_ID })).isError, false);
    await mcp.close();

    const revoke = await fetch(`${base}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshed.body.refresh_token, client_id: client.client_id, client_secret: client.client_secret }),
    });
    assert.equal(revoke.status, 200);
    const after = await token({
      grant_type: 'refresh_token',
      refresh_token: refreshed.body.refresh_token,
      client_id: client.client_id,
      client_secret: client.client_secret,
    });
    assert.equal(after.status, 400);
    assert.equal(after.body.error, 'invalid_grant');
  });
});

describe('tools', () => {
  let mcp: Client;

  before(async () => {
    const { tokens } = await fullSignIn();
    mcp = await connect(tokens.access_token);
  });

  after(async () => {
    await mcp.close();
  });

  test('all tools and prompts are listed, all marked read-only', async () => {
    const { tools } = await mcp.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        'describe_resource',
        'generate_keyword_ideas',
        'get_account_overview',
        'get_ad_group_performance',
        'get_ads',
        'get_asset_group_performance',
        'get_breakdown',
        'get_budget_pacing',
        'get_campaign_performance',
        'get_change_history',
        'get_conversion_setup',
        'get_keyword_performance',
        'get_negative_keywords',
        'get_performance_trend',
        'get_recommendations',
        'get_search_terms',
        'list_accounts',
        'run_gaql_query',
      ],
    );
    assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false));
    const { prompts } = await mcp.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name).sort(), ['account_audit', 'wasted_spend_review', 'weekly_report']);
    const prompt = await mcp.getPrompt({ name: 'account_audit', arguments: { customer_id: '123-456-7890' } });
    assert.match(String((prompt.messages[0]!.content as { text: string }).text), /123-456-7890/);
  });

  test('list_accounts walks manager hierarchies and says how to reach each account', async () => {
    const { json } = await call(mcp, 'list_accounts');
    const rows = json!.rows as unknown[][];
    const idx = (c: string) => (json!.columns as string[]).indexOf(c);
    const byId = new Map(rows.map((r) => [r[idx('customer_id')], r]));
    assert.equal(byId.get('123-456-7890')![idx('login_customer_id')], null, 'directly accessible account needs no login id');
    assert.equal(byId.get('555-666-7777')![idx('login_customer_id')], '111-222-3333', 'managed account goes through the manager');
    assert.equal(byId.get('111-222-3333')![idx('manager')], true);
    assert.equal(json!.signed_in_as, 'owner@example.edu');
  });

  test('get_account_overview converts money, compares periods and reports the date range', async () => {
    const { isError, json, text } = await call(mcp, 'get_account_overview', { customer_id: DIRECT_CLIENT_ID, date_range: 'last_7_days' });
    assert.equal(isError, false, text);
    assert.equal(json!.currency, 'INR');
    assert.equal(json!.date_range.days, 7);
    assert.equal(json!.current.cost, 2.5, '2,500,000 micros = 2.5');
    assert.equal(json!.current.ctr, 5, '50 clicks / 1000 impressions = 5%');
    assert.equal(json!.optimization_score_pct, 83);
    assert.ok(json!.previous_period);
    assert.equal(json!.change_pct.cost, 0);
  });

  test('the default manager is skipped automatically when it does not cover the account', async () => {
    const before = fake.queries.length;
    const { isError } = await call(mcp, 'get_campaign_performance', { customer_id: DIRECT_CLIENT_ID });
    assert.equal(isError, false);
    const used = fake.queries.slice(before).filter((q) => q.customerId === DIRECT_CLIENT_ID);
    assert.ok(used.some((q) => q.login === '9990001111'), 'tried the configured manager first');
    assert.ok(used.some((q) => q.login === undefined), 'then fell back to direct access');
  });

  test('an explicit login_customer_id reaches a managed account; a wrong one explains itself', async () => {
    const good = await call(mcp, 'get_account_overview', { customer_id: MANAGED_CLIENT_ID, login_customer_id: MANAGER_ID });
    assert.equal(good.isError, false, good.text);
    const bad = await call(mcp, 'get_account_overview', { customer_id: MANAGED_CLIENT_ID, login_customer_id: DIRECT_CLIENT_ID });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /USER_PERMISSION_DENIED/);
    assert.match(bad.text, /Hint: .*list_accounts/);
  });

  test('manager accounts are refused for performance reports', async () => {
    const res = await call(mcp, 'get_campaign_performance', { customer_id: MANAGER_ID });
    assert.equal(res.isError, true);
    assert.match(res.text, /manager account/);
  });

  test('every report tool returns a well-formed table', async () => {
    const cid = { customer_id: DIRECT_CLIENT_ID };
    const cases: [string, Record<string, unknown>][] = [
      ['get_performance_trend', { ...cid, granularity: 'week' }],
      ['get_campaign_performance', { ...cid, compare: true, channel_types: ['search', 'PERFORMANCE_MAX'] }],
      ['get_ad_group_performance', { ...cid, campaign_id: '101' }],
      ['get_asset_group_performance', cid],
      ['get_budget_pacing', cid],
      ['get_keyword_performance', { ...cid, only: 'no_conversions' }],
      ['get_keyword_performance', { ...cid, max_quality_score: 4 }],
      ['get_search_terms', { ...cid, only: 'no_conversions', min_clicks: 2 }],
      ['get_ads', cid],
      ['get_ads', { ...cid, policy_issues_only: true }],
      ['get_breakdown', { ...cid, dimension: 'device' }],
      ['get_breakdown', { ...cid, dimension: 'hour_of_day' }],
      ['get_breakdown', { ...cid, dimension: 'day_of_week' }],
      ['get_breakdown', { ...cid, dimension: 'city', campaign_id: '101' }],
      ['get_breakdown', { ...cid, dimension: 'age' }],
      ['get_breakdown', { ...cid, dimension: 'gender' }],
      ['get_conversion_setup', { ...cid, start_date: '2026-10-01', end_date: '2026-10-27' }],
      ['get_recommendations', cid],
      ['get_change_history', { ...cid, days: 7 }],
      ['run_gaql_query', { ...cid, query: 'SELECT campaign.id, campaign.name, metrics.cost_micros FROM campaign' }],
    ];
    for (const [name, args] of cases) {
      const { isError, json, text } = await call(mcp, name, args);
      assert.equal(isError, false, `${name}: ${text}`);
      const columns = json!.columns as string[];
      const rows = json!.rows as unknown[][];
      assert.ok(Array.isArray(columns) && columns.length > 0, `${name} has columns`);
      assert.ok(Array.isArray(rows), `${name} has rows`);
      for (const row of rows) assert.equal(row.length, columns.length, `${name}: row width matches columns`);
    }
  });

  test('report details: keyword notation, impression share, pacing, breakdown names, change values', async () => {
    const cid = { customer_id: DIRECT_CLIENT_ID };
    const col = (json: Record<string, any>, name: string) => (json.columns as string[]).indexOf(name);

    const kw = (await call(mcp, 'get_keyword_performance', cid)).json!;
    assert.equal(kw.rows[0][col(kw, 'keyword')], '[text 1]');
    assert.equal(kw.rows[1][col(kw, 'keyword')], '"text 2"');

    const camp = (await call(mcp, 'get_campaign_performance', cid)).json!;
    assert.equal(camp.rows[0][col(camp, 'search_is')], 45.67);
    assert.equal(camp.rows[0][col(camp, 'primary_status_reasons')], 'BUDGET_CONSTRAINED');
    assert.match(String(camp.rows[0][col(camp, 'target')]), /^tCPA /);

    const pacing = (await call(mcp, 'get_budget_pacing', cid)).json!;
    assert.deepEqual(
      pacing.rows.map((r: unknown[]) => r[col(pacing, 'daily_budget')]),
      [5, 2.5],
      'sorted by month-to-date spend, money converted from micros',
    );
    assert.equal(pacing.totals.daily_budget, 7.5);
    assert.ok(typeof pacing.totals.projected_month_spend === 'number');

    const city = (await call(mcp, 'get_breakdown', { ...cid, dimension: 'city' })).json!;
    assert.match(String(city.rows[0][0]), /Hyderabad/, 'geo IDs resolved to names');

    const days = (await call(mcp, 'get_breakdown', { ...cid, dimension: 'day_of_week' })).json!;
    assert.deepEqual(
      days.rows.map((r: unknown[]) => r[0]),
      ['MONDAY', 'TUESDAY'],
      'weekdays sorted Monday first',
    );

    const changes = (await call(mcp, 'get_change_history', cid)).json!;
    assert.equal(changes.rows[0][col(changes, 'changes')], 'amountMicros: 500 -> 800');

    const recs = (await call(mcp, 'get_recommendations', cid)).json!;
    assert.equal(recs.rows[0][col(recs, 'est_extra_clicks')], 6);
    assert.deepEqual(recs.rows[0][col(recs, 'details')], { current_budget: 1000, recommended_budget: 1500 });

    const ads = (await call(mcp, 'get_ads', cid)).json!;
    assert.deepEqual(ads.rows[0][col(ads, 'headlines')], ['Admissions Open 2027 [pinned HEADLINE_1]', 'CBSE School in Hyderabad']);

    const gaql = (await call(mcp, 'run_gaql_query', { ...cid, query: 'SELECT campaign.name, metrics.cost_micros FROM campaign' })).json!;
    assert.ok(gaql.columns.includes('metrics.cost'), 'micros renamed');
    assert.ok(!gaql.columns.some((c: string) => c.endsWith('resource_name')), 'resource names dropped unless selected');
  });

  test('negative keywords are grouped by level and list', async () => {
    const { json, isError, text } = await call(mcp, 'get_negative_keywords', { customer_id: DIRECT_CLIENT_ID });
    assert.equal(isError, false, text);
    assert.ok(json!.campaign_level.length > 0);
    assert.ok(json!.ad_group_level.length > 0);
    const types = (json!.shared_lists as { type: string; applied_to: string[] }[]).map((l) => l.type).sort();
    assert.deepEqual(types, ['ACCOUNT_LEVEL_NEGATIVE_KEYWORDS', 'NEGATIVE_KEYWORDS']);
  });

  test('generate_keyword_ideas resolves language and locations, then sorts by volume', async () => {
    const { json, isError, text } = await call(mcp, 'generate_keyword_ideas', {
      customer_id: DIRECT_CLIENT_ID,
      keywords: ['cbse school'],
      url: 'https://example.edu',
      locations: ['Hyderabad', '2356'],
      language: 'te',
    });
    assert.equal(isError, false, text);
    const request = fake.keywordIdeaRequests.at(-1)!;
    assert.equal(request.language, 'languageConstants/101');
    assert.deepEqual(request.geoTargetConstants, ['geoTargetConstants/2356', 'geoTargetConstants/1007740']);
    assert.ok(request.keywordAndUrlSeed);
    assert.equal(json!.rows[0][0], 'best school hyderabad', 'highest volume first');
    assert.deepEqual(json!.rows[1].slice(1), [1900, 'HIGH', 87, 9, 31, [2400, 1900]]);
  });

  test('describe_resource returns fields, segments and metrics', async () => {
    const { json, isError, text } = await call(mcp, 'describe_resource', { resource: 'campaign' });
    assert.equal(isError, false, text);
    assert.deepEqual(json!.metrics, ['metrics.clicks', 'metrics.search_impression_share']);
    assert.equal(json!.fields.rows.length, 2);
    const missing = await call(mcp, 'describe_resource', { resource: 'not_a_resource' });
    assert.equal(missing.isError, true);
  });

  test('query errors are explained with hints', async () => {
    const res = await call(mcp, 'run_gaql_query', { customer_id: DIRECT_CLIENT_ID, query: 'SELECT campaign.nam FROM campaign' });
    assert.equal(res.isError, true);
    assert.match(res.text, /queryError\.UNRECOGNIZED_FIELD/);
    assert.match(res.text, /request fake-request-1/);
    assert.match(res.text, /Hint: Check field names/);
  });

  test('only SELECT queries are accepted, and bad input is reported clearly', async () => {
    const write = await call(mcp, 'run_gaql_query', { customer_id: DIRECT_CLIENT_ID, query: 'UPDATE campaign SET name = x' });
    assert.equal(write.isError, true);
    assert.match(write.text, /Only SELECT/);
    const badDates = await call(mcp, 'get_account_overview', { customer_id: DIRECT_CLIENT_ID, start_date: '2026-10-10' });
    assert.equal(badDates.isError, true);
    assert.match(badDates.text, /both start_date and end_date/);
    const badId = await call(mcp, 'get_account_overview', { customer_id: '12345' });
    assert.equal(badId.isError, true);
    assert.match(badId.text, /10-digit/);
  });

  test('without customer_id, multiple accessible accounts are listed back', async () => {
    const res = await call(mcp, 'get_account_overview');
    assert.equal(res.isError, true);
    assert.match(res.text, /111-222-3333/);
    assert.match(res.text, /list_accounts/);
  });

  test('every query sent to Google is a well-formed SELECT', () => {
    assert.ok(fake.queries.length > 30);
    for (const { query } of fake.queries) {
      assert.match(query, /^SELECT .+ FROM [a-z_]+/);
      assert.doesNotMatch(query, /undefined|null|NaN/);
    }
  });

  test('tool calls are logged without tokens', () => {
    assert.ok(logs.some((l) => /^tool get_account_overview by owner@example\.edu ok/.test(l)));
    assert.ok(logs.some((l) => /^POST \/register 201 /.test(l)), 'request log shows full paths inside auth routes');
    assert.ok(logs.some((l) => /^oauth: refused registration of "Claude" for redirect_uri https:\/\/evil\.example\/callback/.test(l)));
    assert.ok(!logs.some((l) => /gadst_|gadsr_|g-at-|g-rt-/.test(l)), 'no tokens in logs');
  });
});
