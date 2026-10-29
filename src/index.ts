import { createApp } from './app.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { SERVER_NAME, SERVER_VERSION } from './server.js';

let cfg: Config;
try {
  cfg = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const app = createApp(cfg);
const server = app.listen(cfg.port, cfg.host, () => {
  const who = cfg.allowAnyGoogleAccount
    ? 'any Google account'
    : `${cfg.allowedEmails.size} email(s), ${cfg.allowedDomains.size} domain(s)`;
  console.log(
    [
      `${SERVER_NAME} ${SERVER_VERSION} listening on ${cfg.host}:${cfg.port}`,
      `  MCP endpoint (add this in Claude): ${cfg.mcpUrl}`,
      `  Google OAuth redirect URI (add this to the OAuth client): ${cfg.googleRedirectUri}`,
      `  Google Ads API ${cfg.ads.apiVersion}; allowed sign-ins: ${who}`,
      `  default customer: ${cfg.ads.defaultCustomerId ?? 'none'}; login (manager) customer: ${cfg.ads.loginCustomerId ?? 'none'}`,
    ].join('\n'),
  );
});
server.on('error', (error) => {
  console.error(`Could not start: ${error.message}`);
  process.exit(1);
});

const shutdown = (signal: string) => {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
