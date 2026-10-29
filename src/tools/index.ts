import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAccountTools } from './accounts.js';
import { registerAdTools } from './ads.js';
import { registerCampaignTools } from './campaigns.js';
import { registerGaqlTools } from './gaql.js';
import { registerInsightTools } from './insights.js';
import { registerKeywordTools } from './keywords.js';
import type { ToolContext } from './shared.js';

export function registerTools(server: McpServer, ctx: ToolContext): void {
  for (const register of [
    registerAccountTools,
    registerCampaignTools,
    registerKeywordTools,
    registerAdTools,
    registerInsightTools,
    registerGaqlTools,
  ]) {
    register(server, ctx);
  }
}
