/**
 * OAuth 2.1 authorization server for MCP clients (Claude), backed by Google sign-in.
 *
 * Flow: Claude registers itself (DCR) -> /authorize -> Google consent screen
 * (openid, email, adwords) -> /oauth/google/callback -> back to Claude with our
 * code -> /token. Our access token carries the user's Google access token and
 * our refresh token carries their Google refresh token, both encrypted, so each
 * person's Google Ads permissions apply and the server stores nothing.
 */
import type { Request, Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
  ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Config } from '../config.js';
import { Sealer, nowSeconds, randomId, safeEqual, sha256Base64Url } from '../crypto.js';
import { ADWORDS_SCOPE, GoogleOAuth, GoogleOAuthError, type GoogleIdentity, type GoogleTokenResponse } from './google.js';
import { escapeHtml, sendPage } from './pages.js';

/** The single scope this server issues. Clients may omit it. */
export const MCP_SCOPE = 'ads.read';

/** Claude's documented OAuth callbacks (claude.com is announced as a future host). */
export const CLAUDE_REDIRECT_URIS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const STATE_TTL_SECONDS = 600;
const CODE_TTL_SECONDS = 300;

interface ClientPayload {
  r: string[]; // redirect_uris
  n?: string; // client_name
  m: 'none' | 'client_secret_post'; // token_endpoint_auth_method
  t: number; // issued at
}

interface StatePayload {
  c: string; // client fingerprint
  ru: string; // MCP client's redirect_uri
  cc: string; // MCP client's PKCE challenge
  st?: string; // MCP client's state
  sc: string[];
  rs: string; // resource (MCP URL)
  gv: string; // our PKCE verifier for the Google hop
  n: string; // nonce, also stored in a cookie
  exp: number;
}

interface CodePayload {
  c: string;
  ru: string;
  cc: string;
  sc: string[];
  rs: string;
  e: string; // email
  gat: string; // Google access token
  gexp: number; // its expiry (epoch seconds)
  grt: string; // Google refresh token
  j: string; // single-use id
  exp: number;
}

interface AccessPayload {
  c: string;
  sc: string[];
  rs: string;
  e: string;
  gat: string;
  exp: number;
}

interface RefreshPayload {
  c: string;
  sc: string[];
  rs: string;
  e: string;
  grt: string;
  exp: number;
}

/** What tools receive in `extra.authInfo.extra`. */
export interface GoogleAuthExtra {
  email: string;
  googleAccessToken: string;
}

export class GoogleProxyOAuthProvider implements OAuthServerProvider {
  private readonly usedCodes = new Map<string, number>();
  private readonly secureCookies: boolean;

  constructor(
    private readonly cfg: Config,
    private readonly sealer: Sealer,
    private readonly google: GoogleOAuth,
    private readonly log: (message: string) => void = (m) => console.log(m),
  ) {
    this.secureCookies = cfg.publicBaseUrl.startsWith('https://');
  }

  // ---------------------------------------------------------------- clients

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId: string) => this.getClient(clientId),
      registerClient: (client) => this.registerClient(client),
    };
  }

  isAllowedRedirectUri(uri: string): boolean {
    if (CLAUDE_REDIRECT_URIS.includes(uri) || this.cfg.extraRedirectUris.includes(uri)) return true;
    try {
      const url = new URL(uri);
      // Native and CLI clients (Claude Code, MCP Inspector) listen on a loopback port.
      return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
    } catch {
      return false;
    }
  }

  private fingerprint(clientId: string): string {
    return this.sealer.mac('client-fingerprint', clientId).slice(0, 22);
  }

  private registerClient(
    metadata: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): OAuthClientInformationFull {
    const rejected = metadata.redirect_uris.filter((uri) => !this.isAllowedRedirectUri(uri));
    if (rejected.length > 0) {
      this.log(`oauth: refused registration of "${metadata.client_name ?? 'unnamed'}" for redirect_uri ${rejected.join(', ')}`);
      throw new InvalidClientMetadataError(
        `redirect_uri not allowed on this server: ${rejected.join(', ')}. ` +
          'Allowed: Claude (claude.ai / claude.com), loopback http URLs, and EXTRA_REDIRECT_URIS.',
      );
    }
    const grantTypes = metadata.grant_types ?? ['authorization_code', 'refresh_token'];
    if (!grantTypes.includes('authorization_code')) {
      throw new InvalidClientMetadataError('grant_types must include authorization_code');
    }
    const method: ClientPayload['m'] = metadata.token_endpoint_auth_method === 'none' ? 'none' : 'client_secret_post';
    const issuedAt = nowSeconds();
    const payload: ClientPayload = {
      r: metadata.redirect_uris,
      n: metadata.client_name?.slice(0, 80),
      m: method,
      t: issuedAt,
    };
    const clientId = this.sealer.seal('client', payload);
    this.log(`oauth: registered client "${payload.n ?? 'unnamed'}" (${method}) for ${payload.r.join(', ')}`);
    return this.clientInfo(clientId, payload);
  }

  private getClient(clientId: string): OAuthClientInformationFull | undefined {
    const payload = this.sealer.open<ClientPayload>('client', clientId);
    if (!payload) return undefined;
    // Re-check so that removing a URI from EXTRA_REDIRECT_URIS also disables its clients.
    if (!payload.r.every((uri) => this.isAllowedRedirectUri(uri))) return undefined;
    return this.clientInfo(clientId, payload);
  }

  private clientInfo(clientId: string, p: ClientPayload): OAuthClientInformationFull {
    const info: OAuthClientInformationFull = {
      client_id: clientId,
      client_id_issued_at: p.t,
      redirect_uris: p.r,
      client_name: p.n,
      token_endpoint_auth_method: p.m,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
    if (p.m !== 'none') {
      info.client_secret = this.sealer.mac('client-secret', clientId);
      info.client_secret_expires_at = 0; // never
    }
    return info;
  }

  // ---------------------------------------------------------- authorization

  private canonicalResource(resource?: URL): string {
    if (!resource) return this.cfg.mcpUrl;
    const value = resource.href.replace(/#.*$/, '').replace(/\/+$/, '');
    if (value === this.cfg.mcpUrl || value === this.cfg.publicBaseUrl) return this.cfg.mcpUrl;
    throw new InvalidTargetError(`This server only issues tokens for ${this.cfg.mcpUrl}`);
  }

  private grantedScopes(requested?: string[]): string[] {
    const unknown = (requested ?? []).filter((s) => s && s !== MCP_SCOPE);
    if (unknown.length > 0) this.log(`oauth: ignoring unsupported scopes ${unknown.join(' ')}`);
    return [MCP_SCOPE];
  }

  private cookieName(nonce: string): string {
    return `${this.secureCookies ? '__Host-' : ''}gads_oauth_${nonce.slice(0, 10)}`;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const resource = this.canonicalResource(params.resource);
    const nonce = randomId();
    const googleVerifier = randomId(32);
    const state: StatePayload = {
      c: this.fingerprint(client.client_id),
      ru: params.redirectUri,
      cc: params.codeChallenge,
      st: params.state,
      sc: this.grantedScopes(params.scopes),
      rs: resource,
      gv: googleVerifier,
      n: nonce,
      exp: nowSeconds() + STATE_TTL_SECONDS,
    };
    // Binds the Google round trip to this browser (login-CSRF protection).
    res.cookie(this.cookieName(nonce), nonce, {
      httpOnly: true,
      secure: this.secureCookies,
      sameSite: 'lax',
      path: '/',
      maxAge: STATE_TTL_SECONDS * 1000,
    });
    const onlyEmail = this.cfg.allowedEmails.size === 1 ? [...this.cfg.allowedEmails][0] : undefined;
    const onlyDomain =
      this.cfg.allowedEmails.size === 0 && this.cfg.allowedDomains.size === 1 ? [...this.cfg.allowedDomains][0] : undefined;
    res.redirect(
      302,
      this.google.authorizeUrl({
        state: this.sealer.seal('state', state),
        codeChallenge: sha256Base64Url(googleVerifier),
        loginHint: onlyEmail,
        hostedDomain: onlyDomain,
      }),
    );
  }

  isEmailAllowed(email: string): boolean {
    if (this.cfg.allowAnyGoogleAccount) return true;
    const domain = email.split('@')[1] ?? '';
    return this.cfg.allowedEmails.has(email) || this.cfg.allowedDomains.has(domain);
  }

  private clientRedirect(state: StatePayload, params: Record<string, string>): string {
    const url = new URL(state.ru);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (state.st !== undefined) url.searchParams.set('state', state.st);
    return url.toString();
  }

  /** GET /oauth/google/callback */
  async handleGoogleCallback(req: Request, res: Response): Promise<void> {
    const query = req.query as Record<string, unknown>;
    const state = this.sealer.open<StatePayload>('state', typeof query.state === 'string' ? query.state : undefined);
    if (!state) {
      sendPage(res, 400, 'This sign-in link has expired', [
        'Sign-in links are valid for 10 minutes. Go back to Claude and connect again.',
      ]);
      return;
    }
    const cookie = readCookie(req, this.cookieName(state.n));
    res.clearCookie(this.cookieName(state.n), { path: '/', secure: this.secureCookies, httpOnly: true, sameSite: 'lax' });
    if (!cookie || !safeEqual(cookie, state.n)) {
      sendPage(res, 400, 'Sign-in session not found', [
        'The sign-in did not start in this browser, or cookies are blocked for this site.',
        'Go back to Claude and connect again from the same browser.',
      ]);
      return;
    }

    const cancel = (description: string) =>
      this.clientRedirect(state, { error: 'access_denied', error_description: description });

    if (typeof query.error === 'string') {
      this.log(`oauth: Google returned error=${query.error}`);
      res.redirect(302, cancel(`Google sign-in was not completed (${query.error})`));
      return;
    }
    if (typeof query.code !== 'string') {
      sendPage(res, 400, 'Google did not return a sign-in code', ['Go back to Claude and connect again.']);
      return;
    }

    let tokens: GoogleTokenResponse;
    let identity: GoogleIdentity;
    try {
      tokens = await this.google.exchangeCode(query.code, state.gv);
      identity = this.google.identityFromIdToken(tokens.id_token);
    } catch (error) {
      const message = error instanceof GoogleOAuthError ? error.message : String(error);
      this.log(`oauth: Google code exchange failed: ${message}`);
      sendPage(res, 502, 'Google sign-in failed', [
        escapeHtml(message),
        'Check that GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET belong to a "Web application" OAuth client ' +
          `whose authorized redirect URIs include <code>${escapeHtml(this.cfg.googleRedirectUri)}</code>.`,
      ]);
      return;
    }

    const grant = tokens.refresh_token ?? tokens.access_token;
    const revokeAndExplain = (status: number, title: string, paragraphs: string[], reason: string) => {
      void this.google.revoke(grant);
      sendPage(res, status, title, paragraphs, { href: cancel(reason), label: 'Return to Claude' });
    };

    if (!identity.emailVerified) {
      revokeAndExplain(403, 'Email not verified', ['This Google account has no verified email address.'], 'unverified email');
      return;
    }
    if (!this.isEmailAllowed(identity.email)) {
      this.log(`oauth: rejected ${identity.email} (not on the allowlist)`);
      revokeAndExplain(
        403,
        'This Google account is not allowed',
        [
          `<code>${escapeHtml(identity.email)}</code> is not on this server's allowlist.`,
          'Ask the administrator to add it to ALLOWED_EMAILS (or its domain to ALLOWED_EMAIL_DOMAINS), then connect again.',
        ],
        'account not allowed on this server',
      );
      return;
    }
    const granted = (tokens.scope ?? '').split(/\s+/);
    if (!granted.includes(ADWORDS_SCOPE)) {
      revokeAndExplain(
        403,
        'Google Ads permission was not granted',
        [
          'On the Google consent screen, keep the Google Ads box ticked. Google only offers one Google Ads permission, ' +
            'but this server never calls anything except read-only reporting endpoints.',
          'Go back to Claude and connect again.',
        ],
        'Google Ads permission not granted',
      );
      return;
    }
    if (!tokens.refresh_token) {
      sendPage(res, 502, 'Google did not return a refresh token', [
        'Remove this app at <code>myaccount.google.com/permissions</code>, then connect again from Claude.',
      ]);
      return;
    }

    const code: CodePayload = {
      c: state.c,
      ru: state.ru,
      cc: state.cc,
      sc: state.sc,
      rs: state.rs,
      e: identity.email,
      gat: tokens.access_token,
      gexp: nowSeconds() + tokens.expires_in,
      grt: tokens.refresh_token,
      j: randomId(),
      exp: nowSeconds() + CODE_TTL_SECONDS,
    };
    this.log(`oauth: ${identity.email} signed in`);
    res.redirect(302, this.clientRedirect(state, { code: this.sealer.seal('code', code) }));
  }

  // ------------------------------------------------------------------ tokens

  private openCode(client: OAuthClientInformationFull, code: string): CodePayload {
    const payload = this.sealer.open<CodePayload>('code', code);
    if (!payload) throw new InvalidGrantError('Invalid or expired authorization code');
    if (payload.c !== this.fingerprint(client.client_id)) throw new InvalidGrantError('Code was issued to another client');
    return payload;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.openCode(client, authorizationCode).cc;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const code = this.openCode(client, authorizationCode);
    if (redirectUri !== undefined && redirectUri !== code.ru) throw new InvalidGrantError('redirect_uri does not match');
    if (resource && this.canonicalResource(resource) !== code.rs) throw new InvalidTargetError('resource does not match');
    this.pruneUsedCodes();
    if (this.usedCodes.has(code.j)) throw new InvalidGrantError('Authorization code has already been used');
    this.usedCodes.set(code.j, code.exp);
    return this.issueTokens({ c: code.c, sc: code.sc, rs: code.rs, e: code.e, gat: code.gat, gexp: code.gexp, grt: code.grt });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const payload = this.sealer.open<RefreshPayload>('refresh', refreshToken);
    if (!payload) throw new InvalidGrantError('Invalid or expired refresh token. Reconnect the connector.');
    if (payload.c !== this.fingerprint(client.client_id)) throw new InvalidGrantError('Refresh token was issued to another client');
    if (resource && this.canonicalResource(resource) !== payload.rs) throw new InvalidTargetError('resource does not match');
    if (scopes && scopes.some((s) => !payload.sc.includes(s))) throw new InvalidScopeError('Requested scope exceeds the original grant');
    if (!this.isEmailAllowed(payload.e)) throw new InvalidGrantError('This Google account is no longer allowed on this server');

    let google;
    try {
      google = await this.google.refresh(payload.grt);
    } catch (error) {
      if (error instanceof GoogleOAuthError && (error.code === 'invalid_grant' || error.status === 400 || error.status === 401)) {
        this.log(`oauth: Google refresh rejected for ${payload.e}: ${error.message}`);
        throw new InvalidGrantError('Google sign-in expired or was revoked. Reconnect the connector.');
      }
      throw new ServerError(`Could not refresh the Google session: ${(error as Error).message}`);
    }
    return this.issueTokens({
      c: payload.c,
      sc: scopes ?? payload.sc,
      rs: payload.rs,
      e: payload.e,
      gat: google.access_token,
      gexp: nowSeconds() + google.expires_in,
      grt: google.refresh_token ?? payload.grt,
    });
  }

  private issueTokens(t: { c: string; sc: string[]; rs: string; e: string; gat: string; gexp: number; grt: string }): OAuthTokens {
    const now = nowSeconds();
    // Never outlive the Google access token inside it.
    const exp = Math.max(now + 60, Math.min(now + this.cfg.accessTokenTtlSeconds, t.gexp - 60));
    const access: AccessPayload = { c: t.c, sc: t.sc, rs: t.rs, e: t.e, gat: t.gat, exp };
    const refresh: RefreshPayload = { c: t.c, sc: t.sc, rs: t.rs, e: t.e, grt: t.grt, exp: now + this.cfg.refreshTokenTtlSeconds };
    return {
      access_token: this.sealer.seal('access', access),
      token_type: 'Bearer',
      expires_in: exp - now,
      refresh_token: this.sealer.seal('refresh', refresh),
      scope: t.sc.join(' '),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const payload = this.sealer.open<AccessPayload>('access', token);
    if (!payload) throw new InvalidTokenError('Invalid or expired access token');
    if (!this.isEmailAllowed(payload.e)) throw new InvalidTokenError('This Google account is no longer allowed on this server');
    const extra: GoogleAuthExtra = { email: payload.e, googleAccessToken: payload.gat };
    return {
      token,
      clientId: payload.c,
      scopes: payload.sc,
      expiresAt: payload.exp,
      resource: new URL(payload.rs),
      extra: extra as unknown as Record<string, unknown>,
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const refresh = this.sealer.open<RefreshPayload>('refresh', request.token);
    const access = refresh ? null : this.sealer.open<AccessPayload>('access', request.token);
    const payload = refresh ?? access;
    if (!payload || payload.c !== this.fingerprint(client.client_id)) return;
    await this.google.revoke(refresh ? refresh.grt : access!.gat);
    this.log(`oauth: ${payload.e} revoked their session`);
  }

  private pruneUsedCodes(): void {
    const now = nowSeconds();
    for (const [id, exp] of this.usedCodes) if (exp <= now) this.usedCodes.delete(id);
  }
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}
