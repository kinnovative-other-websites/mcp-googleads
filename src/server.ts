import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPrompts } from './prompts.js';
import { registerTools } from './tools/index.js';
import type { ToolContext } from './tools/shared.js';

export const SERVER_NAME = 'google-ads-mcp';
export const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = `Read-only access to Google Ads accounts the signed-in Google user can see.
- If the account is unclear, call list_accounts first. Manager accounts have no metrics; use their client accounts.
- Start analyses with get_account_overview, then drill down (campaigns, keywords, search terms, ads, breakdowns).
- Reports use the account currency and time zone; ctr and conv_rate are percentages. Each report states its exact date range.
- For anything the built-in tools do not cover, use describe_resource then run_gaql_query.
- This server cannot change anything in Google Ads. Never say a change was made. Give step-by-step instructions for the
  Google Ads web interface instead, with the numbers that justify each change.`;

/** A fresh server per HTTP request (stateless Streamable HTTP). */
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, ctx);
  registerPrompts(server);
  return server;
}
