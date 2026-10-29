# Google Ads MCP server (read-only)

Connects Claude (claude.ai, Claude Desktop, Claude mobile and Claude Code) to your Google Ads accounts so you can ask about your campaigns and get concrete suggestions, which you then apply yourself in Google Ads. It runs on your own server as one small Docker container behind nginx.

- **Read-only.** No code path in this server can call a Google Ads write endpoint.
- **Each person signs in with their own Google account** and sees only the Google Ads accounts that account can see. An allowlist decides who may sign in.
- **Nothing is stored on the server.** Tokens are encrypted and held by Claude.

## How it relates to Google's official MCP server

Google publishes an official server, [googleads/google-ads-mcp](https://github.com/googleads/google-ads-mcp), written in Python and documented for local use or Google Cloud Run. It has three generic tools. This server offers the same three abilities: listing accounts, running any Google Ads Query Language (GAQL) query, and describing fields. It adds 15 ready-made reports and 3 guided prompts. Money is converted from micros, periods are compared, and each report states its exact date range.

## Tools

| Tool | Answers |
|---|---|
| `list_accounts` | Which accounts can I reach, including client accounts under a manager (MCC)? |
| `get_account_overview` | Headline results for a period, with % change versus the previous period. |
| `get_performance_trend` | Daily, weekly or monthly results, for the account or one campaign. |
| `get_campaign_performance` | Per-campaign results, status reasons, bidding target, budget, and impression share lost to budget versus rank. |
| `get_ad_group_performance` | Per-ad-group results and default bids. |
| `get_asset_group_performance` | Performance Max asset groups, with ad strength. |
| `get_budget_pacing` | Month-to-date spend versus budget, and projected month-end spend. |
| `get_keyword_performance` | Keywords with Quality Score and its components. Filters for wasted spend or low Quality Score. |
| `get_search_terms` | What people actually searched. Finds negative-keyword and new-keyword candidates. |
| `get_negative_keywords` | Existing negatives at campaign, ad group and shared-list level. |
| `get_ads` | Ad copy, ad strength, approval status and policy problems. |
| `get_breakdown` | Results by device, day of week, hour, network, city, region, age or gender. |
| `get_conversion_setup` | Conversion actions, their settings, and conversions recorded. Shows whether tracking is trustworthy. |
| `get_recommendations` | Google's own recommendations with estimated impact. |
| `get_change_history` | Who changed what in the last 30 days, with old and new values. |
| `generate_keyword_ideas` | Keyword Planner volumes, competition and bid ranges. |
| `run_gaql_query` | Any read-only GAQL query, for anything the reports don't cover. |
| `describe_resource` | GAQL field names and which segments and metrics work with a resource. |

The server also offers three guided prompts in Claude's prompt menu: **Full account audit**, **Find wasted spend**, and **Weekly performance report**.

## How access works

1. Claude registers itself with this server and starts a standard OAuth 2.1 sign-in with PKCE.
2. The server sends you to Google's consent screen. It asks for your email and the Google Ads permission.
3. The server checks your email against `ALLOWED_EMAILS` / `ALLOWED_EMAIL_DOMAINS`, then hands Claude its own tokens.
4. Claude's access token contains your Google access token, and its refresh token contains your Google refresh token. Both are AES-256-GCM encrypted with `MCP_AUTH_SECRET`, so the server keeps no database.
5. Every Google Ads call runs as you.

Google offers only one OAuth permission for Google Ads, and it allows changes. This server never uses that ability. For extra safety, give people who only analyse the **Read only** access level in Google Ads (Admin, then Access and security).

## Setup

### 1. Google Cloud project

Since 9 September 2026, Google Ads API access belongs to a **Google Cloud project**, not to a developer token. Use the project where your Explorer, Basic or Standard access was approved.

1. In **APIs & Services → Library**, enable **Google Ads API**.
2. Configure the **OAuth consent screen** (Google Auth Platform):
   - **Audience.** Choose *Internal* if everyone signs in with your Google Workspace domain. Otherwise choose *External*.
   - **Data access.** Add the scopes `openid`, `.../auth/userinfo.email` and `https://www.googleapis.com/auth/adwords`.
   - **External apps in *Testing*.** Add each person as a test user. Google expires refresh tokens of Testing apps after **7 days**, so people would reconnect weekly. Set the publishing status to **In production** to avoid that. Google then shows a "Google hasn't verified this app" notice at sign-in; choose *Advanced*, then *Go to …*. That's expected for an internal tool.
3. In **Clients → Create client**, choose **Web application**. Add this **Authorized redirect URI**:
   `https://ads-mcp.example.com/oauth/google/callback` (use your hostname).
   Keep the client ID and secret for step 2.

### 2. Server

You need Docker with the compose plugin, nginx, and a hostname such as `ads-mcp.example.com`.

1. **DNS.** Point an A record at the server. On Cloudflare, use *DNS only* (grey cloud). Claude's servers cannot solve bot challenges, so a proxied record can block the connection.
2. **Code.** Copy this folder to the server, for example `/opt/google-ads-mcp`.
3. **Configuration.**
   ```sh
   cp .env.example .env
   openssl rand -base64 48     # paste as MCP_AUTH_SECRET
   nano .env                   # fill in the rest
   chmod 600 .env
   ```
4. **Start.**
   ```sh
   docker compose up -d --build
   docker compose logs          # shows the MCP URL and the Google redirect URI
   ```
   The container listens on `127.0.0.1:8790` only.
5. **Certificate.** For example, with the Cloudflare DNS plugin:
   ```sh
   sudo certbot certonly --dns-cloudflare --dns-cloudflare-credentials /root/.secrets/cloudflare.ini -d ads-mcp.example.com
   ```
6. **nginx.** Copy `deploy/nginx-ads-mcp.conf` to `/etc/nginx/sites-available/`, replace the hostname, enable it, then run `sudo nginx -t && sudo systemctl reload nginx`.
7. **Check from outside.**
   ```sh
   curl https://ads-mcp.example.com/healthz
   curl https://ads-mcp.example.com/.well-known/oauth-protected-resource/mcp
   ```

### 3. Connect Claude

- **claude.ai (Pro, Max).** Open Settings, then Connectors, and choose **Add custom connector**. Name it *Google Ads* and enter `https://ads-mcp.example.com/mcp`. Leave the advanced OAuth fields empty, because the server registers Claude automatically. Click **Connect** and sign in with Google.
- **Team and Enterprise.** An owner adds the connector in the organization's connector settings. Each member then connects with their own Google account.
- **Claude Desktop and mobile.** Connectors added on claude.ai appear there automatically.
- **Claude Code.**
  ```sh
  claude mcp add --transport http google-ads https://ads-mcp.example.com/mcp
  ```
  Then run `/mcp` inside Claude Code, pick *google-ads* and authenticate.

In a chat, turn the connector on from the tools menu and ask away.

## Example questions

- "Which campaigns spent the most last month, and what did each lead cost?"
- "Find search terms from the last 30 days that cost money without converting. Give me negative keywords to add, and where to add them."
- "Conversions dropped this week. Check recent changes and tell me why."
- "Are we on track to overspend this month?"
- "Which keywords have low Quality Score, and what should I fix first?"
- "Is our conversion tracking set up correctly?"

Claude is instructed to never claim it changed anything. It gives you step-by-step instructions for the Google Ads web interface instead.

## Operations

- **Logs.** `docker compose logs -f` shows one line per request and per tool call: who called it, which tool, and how long it took. Tokens and query strings are never logged.
- **Update.** `git pull && docker compose up -d --build`.
- **Remove a person.** Delete them from `ALLOWED_EMAILS` and run `docker compose up -d`. The allowlist is checked on every request, so access stops immediately.
- **Sign everyone out.** Change `MCP_AUTH_SECRET` and restart.
- **Upgrade the Google Ads API version.** Google retires each version about a year after release; v26 came out on 2026-10-14. Before switching, check every built-in query against the new version's field reference, then change `GOOGLE_ADS_API_VERSION` and restart:
  ```sh
  npm run check:gaql -- v27
  ```

## Continuous deployment

Every push to `main` runs the type check and tests in GitHub Actions. If they pass, the workflow deploys to the server: it copies the code with rsync into `/opt/google-ads-mcp`, rebuilds the container, waits for it to be healthy, then checks the public URL. Pull requests only run the tests.

The settings file `.env` lives only on the server. Deploys never overwrite or delete it, so edit it there and run `docker compose up -d` to apply changes.

The deploy job needs four repository secrets. Until they exist, the job is skipped with a notice.

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | The server's IP address. |
| `DEPLOY_USER` | `ubuntu` |
| `DEPLOY_SSH_KEY` | Private key of a key pair used only for deploys. Its public key must be in the server's `~/.ssh/authorized_keys`. |
| `DEPLOY_KNOWN_HOSTS` | The server's host key line, from `ssh-keyscan -t ed25519 <ip>` checked against a trusted login. |

GitHub's runners connect from changing addresses, so the server's firewall must allow SSH from anywhere. Logins work with keys only.

## Development

```sh
npm install
npm test            # 49 unit and end-to-end tests against a fake Google
npm run typecheck
npm run dev         # reads .env; PUBLIC_BASE_URL=http://localhost:8080 works locally
```

For local testing with MCP Inspector, add `http://localhost:8080/oauth/google/callback` to the OAuth client's redirect URIs. Then run `npx @modelcontextprotocol/inspector` and connect to `http://localhost:8080/mcp`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Google shows `redirect_uri_mismatch` | The OAuth client must list exactly `<PUBLIC_BASE_URL>/oauth/google/callback`. |
| Google shows `Error 403: access_denied` | The app is in *Testing* and this account is not a test user. |
| "This Google account is not allowed" | Add the email to `ALLOWED_EMAILS`, or its domain to `ALLOWED_EMAIL_DOMAINS`, then restart. |
| Claude asks to reconnect every week | The consent screen is in *Testing*. Set it to *In production*. |
| Tool error about test accounts or access level | The Cloud project only has test-account access. Apply for Explorer or Basic access for that project. |
| `USER_PERMISSION_DENIED` | Run `list_accounts`, then pass the `login_customer_id` it shows, or fix `GOOGLE_ADS_LOGIN_CUSTOMER_ID`. |
| Google Ads API HTTP 404 | The API version was retired. Raise `GOOGLE_ADS_API_VERSION` after running `check:gaql`. |
| Claude cannot connect | Open `https://<host>/healthz` from outside your network. Check for Cloudflare challenges and the nginx proxy. |
