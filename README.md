# gads-mcp: Google Ads MCP server

Next.js on Vercel + Supabase. In Claude you add one URL, click **Connect**, pick your Google account, and Claude can
read and manage every Google Ads account that Google user can access.

**URL for Claude:** `https://gads-mcp.alifmahmud.com/mcp`

## How the Connect flow works
Claude -> `/mcp` (401) -> Claude registers itself (`/api/oauth/register`) -> opens `/api/oauth/authorize` ->
Google account chooser -> `/api/oauth/google/callback` (we save your Google login, encrypted) -> Claude gets its own
access token (`/api/oauth/token`). `ALLOWED_EMAILS=*` lets any verified Google account sign in; each user only reaches the Ads accounts their own Google login can access. Set a comma-separated list to restrict it.

## Tools
`gads_whoami` · `gads_list_accessible_customers` · `gads_list_child_accounts` · `gads_run_gaql` (any read) ·
`gads_campaign_performance` · `gads_search_terms` · `gads_list_fields` ·
`gads_mutate` (create/update/remove on ANY resource) · `gads_api_request` (any other REST endpoint) ·
shortcuts: `gads_set_campaign_status`, `gads_set_campaign_budget`, `gads_add_campaign_negative_keywords`, `gads_update_ad_final_urls`

**Write safety:** every write defaults to `validate_only=true` (Google checks it, nothing changes). A real change needs
`validate_only=false` **and** `ALLOW_WRITES=true` in Vercel. Deletes need `allow_remove=true`. Executed changes are
written to the `audit_log` table and Vercel logs.

## Setup

### 1. Supabase
1. Open your `gads-mcp` project -> **SQL Editor** -> **New query**.
2. Paste the whole file `supabase/migrations/001_init.sql` -> **Run**, then do the same with `002_grants.sql`.
3. **Project Settings -> API**: copy the **Project URL** and the **service_role** (secret) key. These go only into Vercel, never into chat or code.

### 2. GitHub
Push this folder to your private `gads-mcp` repo:
```
git init && git add . && git commit -m "Google Ads MCP"
git branch -M main
git remote add origin https://github.com/<you>/gads-mcp.git
git push -u origin main
```

### 3. Vercel
1. **Add New -> Project** -> import the repo (Framework: Next.js, default settings).
2. Before deploying, add **Environment Variables** (see `.env.example`):
   | Name | Value |
   |---|---|
   | `APP_URL` | `https://gads-mcp.alifmahmud.com` |
   | `GOOGLE_OAUTH_CLIENT_ID` | from your Google OAuth client |
   | `GOOGLE_OAUTH_CLIENT_SECRET` | from your Google OAuth client (use a fresh secret) |
   | `SUPABASE_URL` | Supabase Project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase **secret** key (`sb_secret_...`), not the publishable key |
   | `ENCRYPTION_KEY` | output of `openssl rand -base64 32` |
   | `ALLOWED_EMAILS` | `*` (any Google account) or a comma-separated list |
   | `ALLOW_WRITES` | `true` (real changes; each still needs `validate_only=false`) |
3. **Deploy**.

### 4. Domain
Vercel project -> **Settings -> Domains** -> add `gads-mcp.alifmahmud.com`. Vercel shows the DNS record to create
(normally a `CNAME` named `gads-mcp` pointing to `cname.vercel-dns.com`, or the value it displays). Add it where
`alifmahmud.com` DNS is managed and wait until Vercel shows a green check.

### 5. Google Cloud (already done, double-check)
- OAuth client redirect URI: `https://gads-mcp.alifmahmud.com/api/oauth/google/callback`
- Scopes: `adwords`, `openid`, `userinfo.email`; publishing status: In production.

### 6. Connect Claude
claude.ai -> Settings -> Connectors -> **Add custom connector** -> URL `https://gads-mcp.alifmahmud.com/mcp`
(leave advanced/OAuth fields empty) -> **Connect** -> choose your Google account -> click through Google's
"unverified app" notice (Advanced -> continue) -> Allow.

Test: ask Claude *"Use gads_whoami, then list my client accounts."*

### 7. Turning on real changes
Everything starts as previews. When you trust it: Vercel -> Settings -> Environment Variables -> `ALLOW_WRITES=true` -> redeploy.

## Troubleshooting
- **Google says "redirect_uri_mismatch"**: the URI in Google Cloud must match `APP_URL` + `/api/oauth/google/callback` exactly.
- **"Not allowed" after sign-in**: the Google account is not in `ALLOWED_EMAILS` (use `*` to allow everyone).
- **No refresh token / sign-in failed**: remove the app at myaccount.google.com/permissions and connect again.
- **403 from Google Ads**: run `gads_whoami`; the manager (MCC) is auto-detected at sign-in, or set `GOOGLE_ADS_LOGIN_CUSTOMER_ID`.
- **"Developer token" error**: add `GOOGLE_ADS_DEVELOPER_TOKEN` (Google Ads manager -> Admin -> API Center) if your account has one.
- **Changed API version**: set `GOOGLE_ADS_API_VERSION` (default `v26`).
