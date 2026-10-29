/**
 * Environment configuration. Everything is validated once at startup so a
 * misconfigured deployment fails loudly instead of at the first sign-in.
 */

export interface Config {
  port: number;
  host: string;
  /** Public origin, e.g. https://ads-mcp.example.com (no trailing slash). */
  publicBaseUrl: string;
  /** The MCP endpoint, which is also the OAuth protected-resource identifier. */
  mcpUrl: string;
  /** Where Google sends the user back after sign-in. Register it on the OAuth client. */
  googleRedirectUri: string;
  google: {
    clientId: string;
    clientSecret: string;
    authorizeUrl: string;
    tokenUrl: string;
    revokeUrl: string;
  };
  authSecret: string;
  allowedEmails: Set<string>;
  allowedDomains: Set<string>;
  allowAnyGoogleAccount: boolean;
  /** Extra OAuth redirect URIs MCP clients may register, beyond Claude's and loopback. */
  extraRedirectUris: string[];
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  trustProxy: string | number | boolean;
  ads: {
    apiVersion: string;
    baseUrl: string;
    developerToken?: string;
    loginCustomerId?: string;
    defaultCustomerId?: string;
    maxRows: number;
  };
}

export class ConfigError extends Error {}

const csv = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Accepts 123-456-7890, 1234567890 or "123 456 7890" and returns the 10 digits. */
export function normalizeCustomerId(value: string): string | null {
  const digits = value.replace(/[\s-]/g, '');
  return /^\d{10}$/.test(digits) ? digits : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) problems.push(`${name} is required`);
    return value ?? '';
  };
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return n;
  };
  const customerId = (name: string): string | undefined => {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    const id = normalizeCustomerId(raw);
    if (!id) problems.push(`${name} must be a 10-digit Google Ads customer ID (dashes allowed)`);
    return id ?? undefined;
  };

  let publicBaseUrl = required('PUBLIC_BASE_URL').replace(/\/+$/, '');
  if (publicBaseUrl) {
    try {
      const url = new URL(publicBaseUrl);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
        problems.push('PUBLIC_BASE_URL must use https:// (http:// is only allowed for localhost)');
      }
      if (url.pathname !== '/' || url.search || url.hash) {
        problems.push('PUBLIC_BASE_URL must be an origin only, e.g. https://ads-mcp.example.com');
      }
      publicBaseUrl = url.origin;
    } catch {
      problems.push('PUBLIC_BASE_URL is not a valid URL');
    }
  }

  const authSecret = required('MCP_AUTH_SECRET');
  if (authSecret && authSecret.length < 32) {
    problems.push('MCP_AUTH_SECRET must be at least 32 characters (try: openssl rand -base64 48)');
  }

  const allowedEmails = new Set(csv(env.ALLOWED_EMAILS).map((e) => e.toLowerCase()));
  const allowedDomains = new Set(csv(env.ALLOWED_EMAIL_DOMAINS).map((d) => d.toLowerCase().replace(/^@/, '')));
  const allowAnyGoogleAccount = env.ALLOW_ANY_GOOGLE_ACCOUNT?.trim().toLowerCase() === 'true';
  if (!allowAnyGoogleAccount && allowedEmails.size === 0 && allowedDomains.size === 0) {
    problems.push(
      'Set ALLOWED_EMAILS and/or ALLOWED_EMAIL_DOMAINS to control who can sign in ' +
        '(or ALLOW_ANY_GOOGLE_ACCOUNT=true to let any Google account with Ads access in)',
    );
  }

  const extraRedirectUris = csv(env.EXTRA_REDIRECT_URIS);
  for (const uri of extraRedirectUris) {
    if (!URL.canParse(uri)) problems.push(`EXTRA_REDIRECT_URIS contains an invalid URL: ${uri}`);
  }

  const apiVersion = (env.GOOGLE_ADS_API_VERSION?.trim() || 'v26').toLowerCase();
  if (!/^v\d+$/.test(apiVersion)) problems.push('GOOGLE_ADS_API_VERSION must look like v26');

  const trustProxyRaw = env.TRUST_PROXY?.trim() || 'loopback, linklocal, uniquelocal';
  const trustProxy: string | number | boolean = /^\d+$/.test(trustProxyRaw)
    ? Number(trustProxyRaw)
    : trustProxyRaw === 'true'
      ? true
      : trustProxyRaw === 'false'
        ? false
        : trustProxyRaw;

  const config: Config = {
    port: int('PORT', 8080, 1, 65535),
    host: env.HOST?.trim() || '0.0.0.0',
    publicBaseUrl,
    mcpUrl: `${publicBaseUrl}/mcp`,
    googleRedirectUri: `${publicBaseUrl}/oauth/google/callback`,
    google: {
      clientId: required('GOOGLE_OAUTH_CLIENT_ID'),
      clientSecret: required('GOOGLE_OAUTH_CLIENT_SECRET'),
      // Overridable only so the test suite can point at a fake Google.
      authorizeUrl: env.GOOGLE_OAUTH_AUTHORIZE_URL?.trim() || 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: env.GOOGLE_OAUTH_TOKEN_URL?.trim() || 'https://oauth2.googleapis.com/token',
      revokeUrl: env.GOOGLE_OAUTH_REVOKE_URL?.trim() || 'https://oauth2.googleapis.com/revoke',
    },
    authSecret,
    allowedEmails,
    allowedDomains,
    allowAnyGoogleAccount,
    extraRedirectUris,
    accessTokenTtlSeconds: int('ACCESS_TOKEN_TTL_SECONDS', 3600, 300, 3600),
    refreshTokenTtlSeconds: int('REFRESH_TOKEN_TTL_DAYS', 90, 1, 365) * 86400,
    trustProxy,
    ads: {
      apiVersion,
      baseUrl: (env.GOOGLE_ADS_API_BASE_URL?.trim() || 'https://googleads.googleapis.com').replace(/\/+$/, ''),
      developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN?.trim() || undefined,
      loginCustomerId: customerId('GOOGLE_ADS_LOGIN_CUSTOMER_ID'),
      defaultCustomerId: customerId('GOOGLE_ADS_DEFAULT_CUSTOMER_ID'),
      maxRows: int('MAX_ROWS', 1000, 50, 10000),
    },
  };

  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
  return config;
}
