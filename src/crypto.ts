/**
 * Stateless sealed tokens.
 *
 * Client registrations, OAuth state, authorization codes, access tokens and
 * refresh tokens are all AES-256-GCM encrypted JSON payloads. The server keeps
 * no database: whoever holds a token can present it, nobody can read or forge
 * one without MCP_AUTH_SECRET, and rotating that secret signs everyone out.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export type TokenKind = 'client' | 'state' | 'code' | 'access' | 'refresh';

const PREFIX: Record<TokenKind, string> = {
  client: 'gadsc_',
  state: 'gadss_',
  code: 'gadsa_',
  access: 'gadst_',
  refresh: 'gadsr_',
};

const IV_BYTES = 12;
const TAG_BYTES = 16;

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export const randomId = (bytes = 16): string => randomBytes(bytes).toString('base64url');

export const sha256Base64Url = (value: string): string => createHash('sha256').update(value).digest('base64url');

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export class Sealer {
  private readonly encKey: Buffer;
  private readonly macKey: Buffer;

  constructor(secret: string) {
    this.encKey = Buffer.from(hkdfSync('sha256', secret, 'google-ads-mcp', 'token-encryption-v1', 32));
    this.macKey = Buffer.from(hkdfSync('sha256', secret, 'google-ads-mcp', 'client-mac-v1', 32));
  }

  seal(kind: TokenKind, payload: object): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    cipher.setAAD(Buffer.from(kind));
    const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return PREFIX[kind] + Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
  }

  /**
   * Returns the payload, or null when the token is malformed, was sealed for a
   * different kind, was tampered with, or has an `exp` in the past.
   */
  open<T extends object>(kind: TokenKind, token: string | undefined | null): T | null {
    if (typeof token !== 'string' || !token.startsWith(PREFIX[kind]) || token.length > 8192) return null;
    const raw = Buffer.from(token.slice(PREFIX[kind].length), 'base64url');
    if (raw.length < IV_BYTES + TAG_BYTES + 2) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.encKey, raw.subarray(0, IV_BYTES));
      decipher.setAAD(Buffer.from(kind));
      decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
      const plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]);
      const payload = JSON.parse(plain.toString('utf8')) as T & { exp?: number };
      if (typeof payload.exp === 'number' && payload.exp <= nowSeconds()) return null;
      return payload;
    } catch {
      return null;
    }
  }

  /** Deterministic keyed hash, used for client secrets and short client fingerprints. */
  mac(label: string, value: string): string {
    return createHmac('sha256', this.macKey).update(`${label}\0${value}`).digest('base64url');
  }
}
