/**
 * Minimal Google OAuth 2.0 / OpenID Connect client for the sign-in hop.
 */
import type { Config } from '../config.js';

export const ADWORDS_SCOPE = 'https://www.googleapis.com/auth/adwords';
const SIGN_IN_SCOPES = ['openid', 'email', ADWORDS_SCOPE];

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  token_type?: string;
}

export class GoogleOAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface GoogleIdentity {
  email: string;
  emailVerified: boolean;
  hostedDomain?: string;
}

export class GoogleOAuth {
  constructor(
    private readonly cfg: Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  authorizeUrl(opts: { state: string; codeChallenge: string; loginHint?: string; hostedDomain?: string }): string {
    const url = new URL(this.cfg.google.authorizeUrl);
    url.searchParams.set('client_id', this.cfg.google.clientId);
    url.searchParams.set('redirect_uri', this.cfg.googleRedirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SIGN_IN_SCOPES.join(' '));
    // offline + consent makes Google return a refresh token every time.
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('state', opts.state);
    url.searchParams.set('code_challenge', opts.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (opts.loginHint) url.searchParams.set('login_hint', opts.loginHint);
    if (opts.hostedDomain) url.searchParams.set('hd', opts.hostedDomain);
    return url.toString();
  }

  exchangeCode(code: string, codeVerifier: string): Promise<GoogleTokenResponse> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      redirect_uri: this.cfg.googleRedirectUri,
    });
  }

  refresh(refreshToken: string): Promise<GoogleTokenResponse> {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  /** Best effort: revoking an access or refresh token ends the whole Google grant. */
  async revoke(token: string): Promise<void> {
    try {
      await this.fetchImpl(this.cfg.google.revokeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Ignore: the grant also lapses on its own, and revocation is a courtesy.
    }
  }

  /**
   * Reads the ID token returned directly by Google's token endpoint over TLS.
   * OpenID Connect Core 3.1.3.7 allows skipping the signature check in that
   * case; issuer, audience and expiry are still verified.
   */
  identityFromIdToken(idToken: string | undefined): GoogleIdentity {
    const part = idToken?.split('.')[1];
    if (!part) throw new GoogleOAuthError('Google did not return an ID token', 'missing_id_token', 502);
    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    } catch {
      throw new GoogleOAuthError('Google returned an unreadable ID token', 'bad_id_token', 502);
    }
    const iss = String(claims.iss ?? '');
    if (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') {
      throw new GoogleOAuthError(`Unexpected ID token issuer ${iss}`, 'bad_id_token', 502);
    }
    const aud = claims.aud;
    const audiences = Array.isArray(aud) ? aud.map(String) : [String(aud ?? '')];
    if (!audiences.includes(this.cfg.google.clientId)) {
      throw new GoogleOAuthError('ID token was issued to a different client', 'bad_id_token', 502);
    }
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now() - 300_000) {
      throw new GoogleOAuthError('ID token has expired', 'bad_id_token', 502);
    }
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
    if (!email) throw new GoogleOAuthError('Google did not share the account email', 'missing_email', 502);
    return {
      email,
      emailVerified: claims.email_verified === true || claims.email_verified === 'true',
      hostedDomain: typeof claims.hd === 'string' ? claims.hd : undefined,
    };
  }

  private async tokenRequest(params: Record<string, string>): Promise<GoogleTokenResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.cfg.google.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          ...params,
          client_id: this.cfg.google.clientId,
          client_secret: this.cfg.google.clientSecret,
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new GoogleOAuthError(`Could not reach Google: ${(error as Error).message}`, 'network_error', 503);
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || typeof body.access_token !== 'string') {
      const code = typeof body.error === 'string' ? body.error : `http_${response.status}`;
      const description = typeof body.error_description === 'string' ? body.error_description : response.statusText;
      throw new GoogleOAuthError(`Google token endpoint: ${code} (${description})`, code, response.status);
    }
    return {
      access_token: body.access_token,
      expires_in: typeof body.expires_in === 'number' ? body.expires_in : 3599,
      refresh_token: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
      scope: typeof body.scope === 'string' ? body.scope : undefined,
      id_token: typeof body.id_token === 'string' ? body.id_token : undefined,
      token_type: typeof body.token_type === 'string' ? body.token_type : undefined,
    };
  }
}
