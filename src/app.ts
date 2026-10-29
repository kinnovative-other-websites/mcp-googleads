import express, { type NextFunction, type Request, type Response } from 'express';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.js';
import { Sealer } from './crypto.js';
import { GoogleOAuth } from './auth/google.js';
import { GoogleProxyOAuthProvider, MCP_SCOPE } from './auth/provider.js';
import { escapeHtml, sendPage } from './auth/pages.js';
import { GoogleAdsClient } from './ads/client.js';
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import type { ToolContext } from './tools/shared.js';

export interface AppOptions {
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

const RESOURCE_NAME = 'Google Ads (read-only)';

/** Lets clients send client_id/client_secret with HTTP Basic auth as well as in the form body. */
function basicClientCredentials(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const body = req.body as Record<string, unknown> | undefined;
  if (header?.toLowerCase().startsWith('basic ') && body && typeof body === 'object' && !body.client_id) {
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon > 0) {
      body.client_id = decodeURIComponent(decoded.slice(0, colon));
      body.client_secret = decodeURIComponent(decoded.slice(colon + 1));
    }
  }
  next();
}

export function createApp(cfg: Config, options: AppOptions = {}): express.Express {
  const log = options.log ?? ((message: string) => console.log(`${new Date().toISOString()} ${message}`));
  const sealer = new Sealer(cfg.authSecret);
  const google = new GoogleOAuth(cfg, options.fetchImpl);
  const provider = new GoogleProxyOAuthProvider(cfg, sealer, google, log);
  const toolContext: ToolContext = { cfg, ads: new GoogleAdsClient(cfg.ads, options.fetchImpl), log };
  const mcpUrl = new URL(cfg.mcpUrl);
  const issuer = new URL(cfg.publicBaseUrl);

  const app = express();
  app.set('trust proxy', cfg.trustProxy);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    const started = Date.now();
    // Captured now: mounted routers rewrite req.path. Paths only: query strings carry OAuth codes and state.
    const path = req.path;
    res.on('finish', () => {
      if (path !== '/healthz') log(`${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms ${req.ip ?? ''}`);
    });
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION, ads_api: cfg.ads.apiVersion });
  });

  app.get('/', (_req, res) => {
    sendPage(res, 200, 'Google Ads MCP server', [
      'This server gives Claude read-only access to Google Ads.',
      `In Claude, open Settings, then Connectors, choose "Add custom connector" and enter <code>${escapeHtml(cfg.mcpUrl)}</code>. ` +
        'You will be asked to sign in with the Google account you use for Google Ads.',
    ]);
  });

  app.use(['/token', '/revoke'], express.urlencoded({ extended: false }), basicClientCredentials);

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: issuer,
      baseUrl: issuer,
      resourceServerUrl: mcpUrl,
      scopesSupported: [MCP_SCOPE],
      resourceName: RESOURCE_NAME,
      // Client IDs are sealed tokens made by our provider, and their secrets never expire.
      clientRegistrationOptions: { clientIdGeneration: false, clientSecretExpirySeconds: 0 },
    }),
  );

  // Some clients look for protected-resource metadata at the root path too.
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.set('access-control-allow-origin', '*').json({
      resource: mcpUrl.href,
      authorization_servers: [issuer.href],
      scopes_supported: [MCP_SCOPE],
      resource_name: RESOURCE_NAME,
    });
  });

  app.get('/oauth/google/callback', (req, res, next) => {
    provider.handleGoogleCallback(req, res).catch(next);
  });

  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
    expectedResource: mcpUrl,
  });

  app.post('/mcp', bearer, express.json({ limit: '1mb' }), async (req, res) => {
    const server = createMcpServer(toolContext);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      log(`mcp: request failed: ${(error as Error).message}`);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  const postOnly = (_req: Request, res: Response) => {
    res
      .status(405)
      .set('allow', 'POST')
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless, use POST.' }, id: null });
  };
  app.get('/mcp', bearer, postOnly);
  app.delete('/mcp', bearer, postOnly);

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log(`error: ${(error as Error)?.stack ?? String(error)}`);
    if (!res.headersSent) res.status(500).json({ error: 'server_error', error_description: 'Internal server error' });
  });

  return app;
}
