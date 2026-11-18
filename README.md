# gads-mcp: your own Google Ads MCP server (free, self-hosted)

Connect Claude to your Google Ads accounts with a server **you own**. No paid MCP service, no monthly bill, no one else holding your Google login. It runs on the free plans of Vercel and Supabase, and the code is yours to read and change.

When it is running, you add one URL in Claude, click **Connect**, pick your Google account, and Claude can read and manage every Google Ads account that Google user can access.

**No developer token needed.** Older guides tell you to get a Google Ads developer token from a manager (MCC) account and wait for Google to approve it. You can skip that now. You only need a Google Cloud project with the Google Ads API turned on (Step 4).

## What it costs

| Piece | What it does | Cost |
|---|---|---|
| Vercel (Hobby plan) | Runs the server | Free |
| Supabase (Free plan) | Stores sign-ins and the change log | Free |
| Google Cloud project | Google sign-in and Google Ads API access | Free (no credit card needed) |
| Custom domain (optional) | A nicer URL than `*.vercel.app` | Your registrar's price. Skip it to stay at $0 |

Two things to know: Vercel's Hobby plan is for personal, non-commercial use (check their terms if you run this for a business), and Supabase pauses a free project after about a week with no activity (you can restore it with one click).

## How it works

```
Claude  ->  your server (Vercel)  ->  Google sign-in  ->  your server saves your login (encrypted)
                                                      ->  Claude gets its own token
Claude  ->  your server  ->  Google Ads API  ->  your ads data
```

Each person only reaches the Google Ads accounts their own Google login can already open.

## What you need before you start

- A **GitHub** account: https://github.com
- A **Google account** that can open your Google Ads accounts
- A **Vercel** account (sign up with GitHub): https://vercel.com
- A **Supabase** account: https://supabase.com
- **Node.js** (optional: only to generate the encryption key with Node, or to run the app on your computer)

It takes about 30 minutes. Keep a notepad open: you will copy several values and paste them into Vercel near the end. **Never paste these values into chat, issues or code.**

---

## Setup, step by step

### Step 1. Get the code

1. Open this repo on GitHub and click **Fork** (top right). This gives you your own copy.
2. You can make your fork **private**. Vercel and Supabase both work with private repos.

### Step 2. Create the database (Supabase)

1. Go to https://supabase.com/dashboard and click **New project**.
2. Name it `gads-mcp`, set a database password (save it somewhere), pick the region closest to you, choose the **Free** plan, and click **Create new project**. Wait about a minute.
3. In the left sidebar open **SQL Editor** -> **New query**.
4. Open `supabase/migrations/001_init.sql` from your fork, copy **all of it**, paste it into the editor and click **Run**. You should see "Success. No rows returned".

   This one file does everything: it creates the tables, locks them down, and gives your server access. There is no second SQL file to run.
5. Open **Project Settings -> API** (it may be called **API Keys**) and copy two values into your notepad:
   - **Project URL** (looks like `https://abcdxyz.supabase.co`). This is `SUPABASE_URL`.
   - **Secret key** (starts with `sb_secret_...`; on older projects it is the `service_role` key). This is `SUPABASE_SERVICE_ROLE_KEY`.

   Do **not** use the publishable / anon key. It is blocked from the tables on purpose.

### Step 3. Create the Vercel project (this gives you your URL)

Google needs your server's URL in Step 4, so create it first.

1. Go to https://vercel.com/new and click **Import** next to your forked `gads-mcp` repo.
2. The framework should show **Next.js**. Leave the build settings as they are.
3. Set **Project Name** to something unique, for example `gads-mcp-yourname`. Your URL will be `https://gads-mcp-yourname.vercel.app`. Write it down: this is your `APP_URL`.
4. Click **Deploy**. The first deploy may show errors. That is expected: the settings are added in Step 5.

### Step 4. Set up Google Cloud (account, Google Ads API, sign-in)

This is the longest step. Take it slowly and follow the order.

**4a. Create your Google Cloud account**

1. Go to https://console.cloud.google.com/.
2. Sign in with the **same Google account that can open your Google Ads accounts**.
3. If this is your first time, Google asks you to pick your country and accept the Terms of Service. Tick the box and click **Agree and continue**.
4. If you see a "Start free trial" or "Activate" banner, you can ignore it. Nothing in this guide needs billing or a credit card.

**4b. Create a project**

1. Click the project picker at the top of the page (it may say **Select a project**).
2. Click **New project**. Name it `gads-mcp` and click **Create**.
3. Wait a few seconds, then open the project picker again and select `gads-mcp`. Check that its name now shows at the top of the page.

**4c. Turn on (apply for) the Google Ads API**

1. In the search bar at the top, type **Google Ads API** and open it (or go to **APIs & Services -> Library** and search there).
2. Click **Enable**. After a few seconds you land on the API's overview page.
3. If Google shows a form asking for access details (company name, website, how you will use the API), fill it in truthfully, for example: *"Internal tool to read and manage my own (or my clients') Google Ads accounts with an AI assistant"*, and submit it. Most projects do not see this form and can carry on straight away.

That is the whole API application. You do not need a developer token or an MCC account.

**4d. Set up the consent screen**

This is the screen Google shows when you click Connect in Claude.

1. Open **APIs & Services -> OAuth consent screen** (Google may call it **Google Auth Platform**). Click **Get started** if you see it.
2. **App information**: App name `gads-mcp`, support email = your email. Click **Next**.
3. **Audience**: choose **External**. Click **Next**.
4. **Contact information**: your email. Click **Next**, tick the policy box and click **Create**.
5. Open **Data Access** (or **Scopes**) -> **Add or remove scopes**. Add these three:
   - `https://www.googleapis.com/auth/adwords` (named "Google Ads API"; if you can't find it in the list, paste it into the **Manually add scopes** box and click **Add to table**)
   - `openid`
   - `.../auth/userinfo.email`

   Click **Update**, then **Save**.
6. Open **Audience** and click **Publish app** -> **Confirm**. The status should now say **In production**.

   Don't skip this. If it stays on **Testing**, Google logs you out every 7 days. "In production" without Google verification is fine for personal use (see Step 6).

**4e. Create the OAuth client (your sign-in keys)**

1. Open **APIs & Services -> Credentials** (or **Clients**) -> **Create credentials -> OAuth client ID**.
2. Application type: **Web application**. Name: `gads-mcp`.
3. Under **Authorized redirect URIs** click **Add URI** and paste your URL from Step 3 followed by `/api/oauth/google/callback`:
   ```
   https://gads-mcp-yourname.vercel.app/api/oauth/google/callback
   ```
   It must match **exactly**: `https`, no trailing slash, no typos.
4. Click **Create**. Copy the **Client ID** (`GOOGLE_OAUTH_CLIENT_ID`) and **Client secret** (`GOOGLE_OAUTH_CLIENT_SECRET`) into your notepad.

### Step 5. Add your settings in Vercel

1. Make an encryption key. Run one of these in a terminal:
   ```
   openssl rand -base64 32
   ```
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
   Copy the output. This is `ENCRYPTION_KEY`. **Save a copy somewhere safe**: if you lose or change it, everyone has to reconnect.
2. In Vercel open your project -> **Settings -> Environment Variables** and add these (also listed in `.env.example`):

   | Name | Value |
   |---|---|
   | `APP_URL` | Your URL from Step 3, e.g. `https://gads-mcp-yourname.vercel.app` (no trailing slash) |
   | `GOOGLE_OAUTH_CLIENT_ID` | From Step 4e |
   | `GOOGLE_OAUTH_CLIENT_SECRET` | From Step 4e |
   | `SUPABASE_URL` | From Step 2 |
   | `SUPABASE_SERVICE_ROLE_KEY` | The `sb_secret_...` key from Step 2 |
   | `ENCRYPTION_KEY` | The key you just made |
   | `ALLOWED_EMAILS` | Your Google email (or several, separated by commas). `*` lets any Google account sign in |
   | `ALLOW_WRITES` | `false` for now (preview only). See Step 8 |

3. Go to **Deployments**, open the newest one, click the **...** menu -> **Redeploy**. New settings only work after a redeploy.
4. Open `https://gads-mcp-yourname.vercel.app`. You should see a page titled **Google Ads MCP** showing your connector URL.

### Step 6. Connect Claude

1. In Claude open **Settings -> Connectors -> Add custom connector**.
2. Name: `Google Ads`. URL (your address + `/mcp`):
   ```
   https://gads-mcp-yourname.vercel.app/mcp
   ```
   Leave any advanced / OAuth fields empty.
3. Click **Connect** and choose your Google account.
4. Google shows **"Google hasn't verified this app"**. This is normal for your own private app. Click **Advanced -> Go to gads-mcp (unsafe) -> Continue**, tick the Google Ads permission, and click **Allow**.
5. You return to Claude and the connector shows as connected.

### Step 7. Test it

Ask Claude:

> Use gads_whoami, then list my client accounts.

If you see your account names, you're done.

### Step 8. Turn on real changes (optional)

Out of the box nothing changes in your ads: every write tool runs as a preview (`validate_only=true`), so Google only checks the request. When you trust the setup:

1. Vercel -> **Settings -> Environment Variables** -> set `ALLOW_WRITES` to `true`.
2. **Redeploy**.
3. Ask Claude to make the change with `validate_only=false`.

A real change needs both: `ALLOW_WRITES=true` on the server **and** `validate_only=false` in the request. Deletes also need `allow_remove=true`. Every real change is recorded in the `audit_log` table in Supabase and in your Vercel logs.

### Optional: use your own domain

Vercel project -> **Settings -> Domains** -> add your domain (for example `gads-mcp.yourdomain.com`) and create the DNS record Vercel shows you (usually a `CNAME` to `cname.vercel-dns.com`). When Vercel shows a green check:

1. Change `APP_URL` in Vercel to the new address and redeploy.
2. Add the new redirect URI (`https://gads-mcp.yourdomain.com/api/oauth/google/callback`) in Google Cloud -> Credentials -> your OAuth client.
3. Update the connector URL in Claude.

---

## Tools

**Accounts (manager accounts handled for you):** `gads_find_account` (search by name or ID across all your MCCs) · `gads_list_child_accounts` · `gads_list_accessible_customers` · `gads_whoami`.
You never pass an MCC: for any account the server works out the right `login-customer-id` itself (cached 30 min, re-checked if Google refuses).

**Read:** `gads_report` (campaign / ad group / ad / keyword / search term / PMax search term / asset group / landing page / geo, split by date, week, month, day of week, hour, **device**, network, **conversion action**) ·
`gads_compare_periods` (this month vs last month, per day, per campaign) · `gads_conversion_actions` · `gads_change_history` · `gads_list_negatives` ·
`gads_campaign_performance` · `gads_search_terms` (Search + PMax) · `gads_run_gaql` (any query) · `gads_list_fields`

**Write:** `gads_add_negative_keywords` (campaign / ad group / shared list / account level, duplicates skipped, many accounts at once) · `gads_add_keywords` ·
`gads_bulk_replace_urls` (ads, keywords, PMax asset groups, sitelink assets) · `gads_bulk_set_status` (pause / enable many) ·
`gads_set_campaign_status` · `gads_set_campaign_budget` · `gads_update_ad_final_urls` ·
`gads_mutate` (create/update/remove on ANY resource) · `gads_api_request` (any other REST endpoint)

## Security notes

- Your Google login (refresh token) is stored encrypted with AES-256-GCM. Claude's own tokens are stored only as SHA-256 hashes.
- Row level security is on for every table with no policies, so the publishable key gets nothing. Only your server's secret key can read or write.
- Set `ALLOWED_EMAILS` to your own email unless you really want others to sign in.
- Never commit `.env` files or `client_secret*.json` (`.gitignore` already blocks them). If a secret leaks, replace it: a new client secret in Google Cloud, a new key in Supabase, then update Vercel.

## Updating an existing install

- **Database:** there is now a single SQL file, `001_init.sql`. The old `002_grants.sql` has been merged into it. If you already ran both, you don't need to do anything. Running `001_init.sql` again is safe.
- **Developer token:** no longer needed. You can delete `GOOGLE_ADS_DEVELOPER_TOKEN` from Vercel. If you leave it set, the server still sends it, which does no harm.

## Troubleshooting

| Problem | Fix |
|---|---|
| `redirect_uri_mismatch` from Google | The redirect URI in Google Cloud must be exactly `APP_URL` + `/api/oauth/google/callback`. Check `https`, spelling and no trailing slash |
| Site shows "Missing environment variable ..." | Add it in Vercel -> Settings -> Environment Variables, then **Redeploy** |
| `permission denied for table ...` | The SQL didn't fully run. Run all of `supabase/migrations/001_init.sql` again |
| "Not allowed" after sign-in | Your Google email isn't in `ALLOWED_EMAILS` |
| "Access blocked" or Google asks for verification | Check the consent screen is **In production** (Step 4d) and that you clicked Advanced -> Go to gads-mcp |
| You have to reconnect every week | The consent screen is still in **Testing**. Publish it (Step 4d), then reconnect |
| "No refresh token" / sign-in failed | Remove the app at https://myaccount.google.com/permissions and click Connect again |
| "Google Ads API has not been used in project ..." or `SERVICE_DISABLED` | The API isn't turned on in this Google Cloud project. Do Step 4c in the **same** project as your OAuth client, wait a few minutes, try again |
| 403 from Google Ads | Run `gads_whoami`. Check your Google user can open that account in Google Ads. If the wrong manager account is used, set `GOOGLE_ADS_LOGIN_CUSTOMER_ID` |
| Everything stopped after a quiet week | Supabase paused the free project. Open the dashboard and click **Restore** |
| Google changed the API version | Set `GOOGLE_ADS_API_VERSION` (default `v26`) |

## Run it on your computer (optional)

```
npm install
cp .env.example .env.local   # fill in the values; set APP_URL to http://localhost:3000
npm run dev
```
Add `http://localhost:3000/api/oauth/google/callback` as another redirect URI in Google Cloud to test sign-in locally.
