/**
 * A fake of the Google endpoints this server talks to: OAuth (authorize,
 * token, revoke) and the Google Ads REST API. Search responses are synthesized
 * from the SELECT list, so every tool's parsing code gets exercised.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const CLIENT_ID = 'fake-client.apps.googleusercontent.com';
export const CLIENT_SECRET = 'fake-google-secret';
export const MANAGER_ID = '1112223333';
export const DIRECT_CLIENT_ID = '1234567890';
export const MANAGED_CLIENT_ID = '5556667777';

type Json = Record<string, unknown>;

export interface FakeGoogle {
  url: string;
  close: () => Promise<void>;
  /** Email the next sign-in will return. */
  email: string;
  /** Whether the next sign-in grants the adwords scope. */
  grantAdwords: boolean;
  queries: { customerId: string; login?: string; query: string }[];
  revoked: Set<string>;
  keywordIdeaRequests: Json[];
}

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function setPath(target: Json, path: string[], value: unknown): void {
  let node = target;
  path.forEach((key, i) => {
    if (i === path.length - 1) node[key] = value;
    else node = (node[key] ??= {}) as Json;
  });
}

/** A plausible REST value for a GAQL field, as the real API would encode it. */
function sample(field: string, index: number): unknown {
  const leaf = field.split('.').pop()!;
  const n = index + 1;
  if (field === 'segments.date') return `2026-10-0${n}`;
  if (field === 'segments.week') return `2026-09-${20 + n}`;
  if (field === 'segments.month') return `2026-0${8 + n}-01`;
  if (field === 'segments.hour') return 8 + n;
  if (field === 'segments.device') return n === 1 ? 'MOBILE' : 'DESKTOP';
  if (field === 'segments.day_of_week') return n === 1 ? 'TUESDAY' : 'MONDAY';
  if (field === 'segments.ad_network_type') return 'SEARCH';
  if (field.startsWith('segments.geo_target')) return `geoTargetConstants/100774${n}`;
  if (field === 'segments.conversion_action') return `customers/${DIRECT_CLIENT_ID}/conversionActions/55${n}`;
  if (field === 'segments.conversion_action_name') return `Lead form ${n}`;
  if (field === 'metrics.impressions') return String(1000 * n);
  if (field === 'metrics.clicks') return String(50 * n);
  if (field === 'metrics.conversions') return 5 * n;
  if (field === 'metrics.all_conversions') return 7 * n;
  if (field.startsWith('metrics.') && field.includes('value')) return 250.5 * n;
  if (field.startsWith('metrics.') && field.includes('impression_share')) return 0.4567;
  if (leaf.endsWith('_micros')) return String(2_500_000 * n);
  if (leaf === 'target_roas') return 4;
  if (leaf === 'id' || leaf.endsWith('_id')) return String(100 + n);
  if (leaf === 'level') return '0';
  if (leaf === 'quality_score') return 3 + n;
  if (leaf.endsWith('quality_score') || leaf === 'search_predicted_ctr') return 'BELOW_AVERAGE';
  if (leaf === 'match_type') return n === 1 ? 'EXACT' : 'PHRASE';
  if (leaf === 'primary_status_reasons') return ['BUDGET_CONSTRAINED'];
  if (leaf === 'primary_status') return 'LIMITED';
  if (leaf === 'status' || leaf === 'approval_status') return field.includes('policy_summary') ? 'APPROVED_LIMITED' : 'ENABLED';
  if (leaf === 'final_urls') return ['https://example.edu/admissions'];
  if (leaf === 'headlines') return [{ text: 'Admissions Open 2027', pinnedField: 'HEADLINE_1' }, { text: 'CBSE School in Hyderabad' }];
  if (leaf === 'descriptions') return [{ text: 'Book a campus visit today.' }];
  if (leaf === 'policy_topic_entries') return [{ topic: 'TRADEMARKS_IN_AD_TEXT', type: 'LIMITED' }];
  if (leaf === 'impact') return { baseMetrics: { clicks: 10, costMicros: '1000000' }, potentialMetrics: { clicks: 16, costMicros: '1800000' } };
  if (leaf === 'campaign_budget_recommendation') return { currentBudgetAmountMicros: '1000000000', recommendedBudgetAmountMicros: '1500000000' };
  if (leaf === 'keyword_recommendation') return { keyword: { text: 'school admission', matchType: 'PHRASE' }, recommendedCpcBidMicros: '12000000' };
  if (leaf === 'changed_fields') return 'amountMicros';
  if (leaf === 'old_resource') return { campaignBudget: { amountMicros: '500000000' } };
  if (leaf === 'new_resource') return { campaignBudget: { amountMicros: '800000000' } };
  if (leaf === 'change_date_time') return `2026-10-2${n} 10:15:00`;
  if (leaf === 'change_resource_type') return 'CAMPAIGN_BUDGET';
  if (leaf === 'resource_change_operation') return 'UPDATE';
  if (leaf === 'client_type') return 'GOOGLE_ADS_WEB_CLIENT';
  if (leaf === 'user_email') return 'marketer@example.edu';
  if (field === 'change_event.campaign' || field === 'recommendation.campaign') return `customers/${DIRECT_CLIENT_ID}/campaigns/10${n}`;
  if (field === 'change_event.ad_group' || field === 'recommendation.ad_group') return `customers/${DIRECT_CLIENT_ID}/adGroups/10${n}`;
  if (field === 'campaign.campaign_budget') return `customers/${DIRECT_CLIENT_ID}/campaignBudgets/${n}`;
  if (leaf === 'period') return 'DAILY';
  if (leaf === 'type' && field.startsWith('shared_set')) return n === 1 ? 'NEGATIVE_KEYWORDS' : 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS';
  if (leaf === 'type') return field.startsWith('ad_group_criterion.age_range') ? `AGE_RANGE_${25 + n}_${34 + n}` : 'SEARCH';
  if (leaf === 'optimization_score') return 0.83;
  if (leaf === 'click_through_lookback_window_days') return '30';
  if (['manager', 'test_account', 'hidden', 'explicitly_shared', 'dismissed'].includes(leaf)) return false;
  if (['primary_for_goal', 'include_in_conversions_metric', 'auto_tagging_enabled', 'targetable'].includes(leaf)) return true;
  if (leaf === 'currency_code') return 'INR';
  if (leaf === 'time_zone') return 'Asia/Kolkata';
  if (leaf === 'canonical_name') return `Hyderabad ${n},Telangana,India`;
  if (leaf === 'code') return 'te';
  return `${leaf} ${n}`;
}

function searchRows(customerId: string, query: string): Json[] {
  const match = /SELECT\s+(.+?)\s+FROM\s+(\w+)/is.exec(query);
  if (!match) return [];
  const fields = match[1]!.split(',').map((f) => f.trim());
  const from = match[2]!;
  const limit = Number(/LIMIT\s+(\d+)/i.exec(query)?.[1] ?? 2);
  if (from === 'customer_client') {
    const self = { id: customerId, level: '0', manager: customerId === MANAGER_ID, descriptiveName: `Account ${customerId}` };
    const children =
      customerId === MANAGER_ID
        ? [
            { id: DIRECT_CLIENT_ID, level: '1', manager: false, descriptiveName: 'Direct School' },
            { id: MANAGED_CLIENT_ID, level: '1', manager: false, descriptiveName: 'Managed School' },
          ]
        : [];
    return [self, ...children].map((c) => ({
      customerClient: { ...c, currencyCode: 'INR', timeZone: 'Asia/Kolkata', status: 'ENABLED', testAccount: false, hidden: false },
    }));
  }
  if (from === 'customer' && fields.includes('customer.descriptive_name')) {
    return [
      {
        customer: {
          resourceName: `customers/${customerId}`,
          id: customerId,
          descriptiveName: customerId === MANAGER_ID ? 'Agency MCC' : 'Test School',
          currencyCode: 'INR',
          timeZone: 'Asia/Kolkata',
          manager: customerId === MANAGER_ID,
          testAccount: false,
          status: 'ENABLED',
        },
      },
    ];
  }
  if (from === 'geo_target_constant') {
    const ids = [...query.matchAll(/geoTargetConstants\/(\d+)/g)].map((m) => m[1]!);
    return ids.map((id) => ({ geoTargetConstant: { id, name: `City ${id}`, canonicalName: `Hyderabad ${id},Telangana,India` } }));
  }
  const rows: Json[] = [];
  // Account-level (FROM customer) queries return one row, as the real API does.
  for (let i = 0; i < Math.min(from === 'customer' ? 1 : 2, limit); i++) {
    const row: Json = {};
    for (const field of fields) setPath(row, field.split('.').map(camel), sample(field, i));
    // The real API adds resourceName to each resource object; mimic that.
    for (const [key, value] of Object.entries(row)) {
      if (key !== 'metrics' && key !== 'segments' && value && typeof value === 'object') (value as Json).resourceName ??= `customers/${customerId}/${key}s/${i}`;
    }
    rows.push(row);
  }
  return rows;
}

function adsFailure(status: number, code: Json, message: string): Json {
  return {
    error: {
      code: status,
      message: 'Request contains an invalid argument.',
      status: status === 403 ? 'PERMISSION_DENIED' : 'INVALID_ARGUMENT',
      details: [
        {
          '@type': 'type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure',
          errors: [{ errorCode: code, message }],
          requestId: 'fake-request-1',
        },
      ],
    },
  };
}

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const codes = new Map<string, { challenge: string; email: string; scope: string }>();
  const refreshTokens = new Map<string, string>();
  let counter = 0;
  const state: Omit<FakeGoogle, 'url' | 'close'> = {
    email: 'owner@example.edu',
    grantAdwords: true,
    queries: [],
    revoked: new Set(),
    keywordIdeaRequests: [],
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };

    if (url.pathname === '/o/oauth2/v2/auth') {
      if (url.searchParams.get('client_id') !== CLIENT_ID) return send(400, { error: 'invalid_client' });
      const code = `g-code-${++counter}`;
      const scope = state.grantAdwords ? 'openid email https://www.googleapis.com/auth/adwords' : 'openid email';
      codes.set(code, { challenge: url.searchParams.get('code_challenge') ?? '', email: state.email, scope });
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }

    if (url.pathname === '/token') {
      const form = new URLSearchParams(raw);
      if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) return send(401, { error: 'invalid_client' });
      if (form.get('grant_type') === 'authorization_code') {
        const entry = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        if (!entry || createHash('sha256').update(verifier).digest('base64url') !== entry.challenge) {
          return send(400, { error: 'invalid_grant', error_description: 'Bad code or verifier' });
        }
        const n = ++counter;
        refreshTokens.set(`g-rt-${n}`, entry.email);
        const idToken = [
          Buffer.from('{"alg":"none"}').toString('base64url'),
          Buffer.from(
            JSON.stringify({
              iss: 'https://accounts.google.com',
              aud: CLIENT_ID,
              exp: Math.floor(Date.now() / 1000) + 3600,
              email: entry.email,
              email_verified: true,
            }),
          ).toString('base64url'),
          'sig',
        ].join('.');
        return send(200, { access_token: `g-at-${n}`, expires_in: 3599, refresh_token: `g-rt-${n}`, scope: entry.scope, id_token: idToken, token_type: 'Bearer' });
      }
      if (form.get('grant_type') === 'refresh_token') {
        const token = form.get('refresh_token') ?? '';
        if (!refreshTokens.has(token) || state.revoked.has(token)) return send(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        return send(200, { access_token: `g-at-${++counter}`, expires_in: 3599, scope: 'openid email https://www.googleapis.com/auth/adwords', token_type: 'Bearer' });
      }
      return send(400, { error: 'unsupported_grant_type' });
    }

    if (url.pathname === '/revoke') {
      state.revoked.add(new URLSearchParams(raw).get('token') ?? '');
      return send(200, {});
    }

    // ---- Google Ads API
    const auth = req.headers.authorization ?? '';
    if (url.pathname.startsWith('/v26/') && !/^Bearer g-at-\d+$/.test(auth)) {
      return send(401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } });
    }
    if (url.pathname === '/v26/customers:listAccessibleCustomers') {
      return send(200, { resourceNames: [`customers/${MANAGER_ID}`, `customers/${DIRECT_CLIENT_ID}`] });
    }
    const search = /^\/v26\/customers\/(\d+)\/googleAds:search$/.exec(url.pathname);
    if (search) {
      const customerId = search[1]!;
      const login = req.headers['login-customer-id'] as string | undefined;
      const body = JSON.parse(raw) as { query: string; pageSize?: number };
      state.queries.push({ customerId, login, query: body.query });
      if (body.pageSize !== undefined) return send(400, adsFailure(400, { requestError: 'PAGE_SIZE_NOT_SUPPORTED' }, 'page_size is not supported'));
      const allowedLogins: Record<string, (string | undefined)[]> = {
        [MANAGER_ID]: [undefined, MANAGER_ID],
        [DIRECT_CLIENT_ID]: [undefined, DIRECT_CLIENT_ID, MANAGER_ID],
        [MANAGED_CLIENT_ID]: [MANAGER_ID],
      };
      if (!(allowedLogins[customerId] ?? []).includes(login)) {
        return send(403, adsFailure(403, { authorizationError: 'USER_PERMISSION_DENIED' }, "User doesn't have permission to access customer."));
      }
      if (/campaign\.nam\b/.test(body.query)) {
        return send(400, adsFailure(400, { queryError: 'UNRECOGNIZED_FIELD' }, "Unrecognized field in the query: 'campaign.nam'."));
      }
      if (customerId === MANAGER_ID && /metrics\./.test(body.query) && !/FROM customer_client/i.test(body.query)) {
        return send(400, adsFailure(400, { queryError: 'REQUESTED_METRICS_FOR_MANAGER' }, 'Metrics cannot be requested for a manager account.'));
      }
      return send(200, { results: searchRows(customerId, body.query), fieldMask: 'x' });
    }
    if (url.pathname === '/v26/googleAdsFields:search') {
      const { query } = JSON.parse(raw) as { query: string };
      if (/WHERE name = 'campaign'/.test(query)) {
        return send(200, {
          results: [
            {
              name: 'campaign',
              category: 'RESOURCE',
              attributeResources: ['customer', 'campaign_budget'],
              metrics: ['metrics.clicks', 'metrics.search_impression_share'],
              segments: ['segments.date', 'segments.device'],
            },
          ],
        });
      }
      if (/LIKE 'campaign\.%'/.test(query)) {
        return send(200, {
          results: [
            { name: 'campaign.status', dataType: 'ENUM', selectable: true, filterable: true, sortable: true, enumValues: ['ENABLED', 'PAUSED', 'REMOVED'] },
            { name: 'campaign.name', dataType: 'STRING', selectable: true, filterable: true, sortable: true },
          ],
        });
      }
      return send(200, { results: [] });
    }
    if (/^\/v26\/customers\/\d+:generateKeywordIdeas$/.test(url.pathname)) {
      state.keywordIdeaRequests.push(JSON.parse(raw) as Json);
      return send(200, {
        results: [
          {
            text: 'cbse school near me',
            keywordIdeaMetrics: {
              avgMonthlySearches: '1900',
              competition: 'HIGH',
              competitionIndex: '87',
              lowTopOfPageBidMicros: '9000000',
              highTopOfPageBidMicros: '31000000',
              monthlySearchVolumes: [
                { year: '2026', month: 'AUGUST', monthlySearches: '2400' },
                { year: '2026', month: 'SEPTEMBER', monthlySearches: '1900' },
              ],
            },
          },
          { text: 'best school hyderabad', keywordIdeaMetrics: { avgMonthlySearches: '5400', competition: 'MEDIUM' } },
        ],
      });
    }
    if (url.pathname === '/v26/geoTargetConstants:suggest') {
      const { locationNames } = JSON.parse(raw) as { locationNames: { names: string[] } };
      return send(200, {
        geoTargetConstantSuggestions: locationNames.names.map((name, i) => ({
          searchTerm: name,
          geoTargetConstant: { resourceName: `geoTargetConstants/100774${i}`, canonicalName: `${name},Telangana,India` },
        })),
      });
    }
    send(404, { error: { code: 404, message: `No fake for ${url.pathname}` } });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}
