import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { Ads } from "@/lib/ads";
import {
  campaignIdField,
  customerIdField,
  dateClause,
  dateRangeField,
  endDateField,
  renderRows,
  ResponseFormat,
  responseFormatField,
  startDateField,
  text
} from "@/lib/format";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export function registerReadTools(server: McpServer, api: Ads): void {
  server.registerTool(
    "gads_whoami",
    {
      title: "Connection Status",
      description: "Show which Google account is connected, which manager (MCC) account is used, and whether real changes (writes) are enabled on this server. Use this first when something fails.",
      inputSchema: z.strictObject({}),
      annotations: READ_ONLY
    },
    async () => {
      const info = await api.getUserInfo();
      return text(
        `Connected Google account: ${info.email}\nManager (MCC) account: ${info.loginCustomerId ?? "none detected (accounts are accessed directly)"}\nReal changes enabled: ${info.writesEnabled ? "yes" : "no (previews only; set ALLOW_WRITES=true in Vercel to enable)"}`
      );
    }
  );

  server.registerTool(
    "gads_list_accessible_customers",
    {
      title: "List Accessible Customers",
      description: `List the Google Ads customer IDs the authorized Google user can access directly.

Use this first to discover account IDs. For accounts under your MCC, use gads_list_child_accounts instead (it returns names, currency and status).`,
      inputSchema: z.strictObject({}),
      annotations: READ_ONLY
    },
    async (_args, ctx) => {
      const data = await api.adsFetch<{ resourceNames?: string[] }>("customers:listAccessibleCustomers", {
        method: "GET",
        loginCustomerId: null,
        signal: ctx.mcpReq.signal
      });
      const ids = (data.resourceNames ?? []).map(r => r.replace("customers/", ""));
      return text(ids.length ? `Accessible customer IDs (${ids.length}):\n${ids.map(i => `- ${i}`).join("\n")}` : "No accessible customers found for this Google user.");
    }
  );

  server.registerTool(
    "gads_list_child_accounts",
    {
      title: "List Child Accounts",
      description: `List client accounts under a manager (MCC) account, with name, currency, time zone and status.

Defaults to the configured GOOGLE_ADS_LOGIN_CUSTOMER_ID. Example: "Which client accounts do I manage?"`,
      inputSchema: z.strictObject({
        manager_id: customerIdField.optional().describe("Manager account ID. Defaults to the configured MCC."),
        include_inactive: z.boolean().default(false).describe("Include canceled/suspended accounts"),
        response_format: responseFormatField
      }),
      annotations: READ_ONLY
    },
    async ({ manager_id, include_inactive, response_format }, ctx) => {
      const mcc = manager_id ?? (await api.getDefaultLoginId());
      if (!mcc) return text("No manager account was detected. Pass manager_id, or sign in again on the /connect page.");
      const statusFilter = include_inactive ? "" : "AND customer_client.status = 'ENABLED'";
      const { rows } = await api.gaqlSearch(
        mcc,
        `SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.status, customer_client.currency_code, customer_client.time_zone, customer_client.level FROM customer_client WHERE customer_client.level >= 1 ${statusFilter} ORDER BY customer_client.descriptive_name`,
        { loginCustomerId: mcc, signal: ctx.mcpReq.signal }
      );
      return renderRows(rows, response_format, { title: `Accounts under ${mcc}` }, 500);
    }
  );

  server.registerTool(
    "gads_run_gaql",
    {
      title: "Run GAQL Query",
      description: `Run any read-only Google Ads Query Language (GAQL) query against one account.

Cost fields ending in *_micros (and average_cpc, cost_per_conversion) are converted to currency units in the output. Use LIMIT in the query for big resources. Prefer gads_campaign_performance / gads_search_terms for common reports.

Examples:
  - "SELECT campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS"
  - "SELECT ad_group_ad.ad.final_urls, ad_group_ad.status FROM ad_group_ad WHERE campaign.id = 123"`,
      inputSchema: z.strictObject({
        customer_id: customerIdField,
        query: z.string().min(10).max(5000).describe("A complete GAQL SELECT statement"),
        limit: z.number().int().min(1).max(1000).default(50).describe("Maximum rows to return"),
        page_token: z.string().optional().describe("next_page_token from a previous call"),
        response_format: responseFormatField
      }),
      annotations: READ_ONLY
    },
    async ({ customer_id, query, limit, page_token, response_format }, ctx) => {
      if (!/^\s*select\b/i.test(query)) return text("Only GAQL SELECT statements are allowed.");
      const { rows, nextPageToken, total } = await api.gaqlSearch(customer_id, query, {
        pageSize: limit,
        pageToken: page_token,
        signal: ctx.mcpReq.signal
      });
      return renderRows(rows, response_format, { title: "GAQL results", total, nextPageToken }, limit);
    }
  );

  server.registerTool(
    "gads_campaign_performance",
    {
      title: "Campaign Performance",
      description: `Campaign-level performance for one account, sorted by cost (highest first): impressions, clicks, CTR, avg CPC, cost, conversions, conversion value, cost per conversion.

Example: "How did the Vending Machine Distributor account perform last 30 days?"`,
      inputSchema: z.strictObject({
        customer_id: customerIdField,
        date_range: dateRangeField,
        start_date: startDateField,
        end_date: endDateField,
        only_enabled: z.boolean().default(true).describe("Only campaigns that are currently enabled"),
        limit: z.number().int().min(1).max(200).default(50),
        response_format: responseFormatField
      }),
      annotations: READ_ONLY
    },
    async ({ customer_id, date_range, start_date, end_date, only_enabled, limit, response_format }, ctx) => {
      const status = only_enabled ? "campaign.status = 'ENABLED'" : "campaign.status != 'REMOVED'";
      const query = `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.cost_per_conversion FROM campaign WHERE ${dateClause(date_range, start_date, end_date)} AND ${status} ORDER BY metrics.cost_micros DESC`;
      const { rows, nextPageToken, total } = await api.gaqlSearch(customer_id, query, { pageSize: limit, signal: ctx.mcpReq.signal });
      return renderRows(rows, response_format, { title: `Campaign performance (${start_date && end_date ? `${start_date} to ${end_date}` : date_range})`, total, nextPageToken }, limit);
    }
  );

  server.registerTool(
    "gads_search_terms",
    {
      title: "Search Terms Report",
      description: `Search terms that triggered ads (Search campaigns), sorted by cost. Use it to find wasted spend and negative keyword candidates; then use gads_add_campaign_negative_keywords.

Note: Performance Max search terms are not included here.`,
      inputSchema: z.strictObject({
        customer_id: customerIdField,
        campaign_id: campaignIdField.optional().describe("Limit to one campaign"),
        date_range: dateRangeField,
        start_date: startDateField,
        end_date: endDateField,
        min_clicks: z.number().int().min(0).default(1).describe("Only terms with at least this many clicks"),
        zero_conversions_only: z.boolean().default(false).describe("Only terms with 0 conversions (negative keyword candidates)"),
        limit: z.number().int().min(1).max(500).default(50),
        response_format: responseFormatField
      }),
      annotations: READ_ONLY
    },
    async ({ customer_id, campaign_id, date_range, start_date, end_date, min_clicks, zero_conversions_only, limit, response_format }, ctx) => {
      const filters = [dateClause(date_range, start_date, end_date), `metrics.clicks >= ${min_clicks}`];
      if (campaign_id) filters.push(`campaign.id = ${campaign_id}`);
      if (zero_conversions_only) filters.push("metrics.conversions = 0");
      const query = `SELECT search_term_view.search_term, search_term_view.status, campaign.id, campaign.name, ad_group.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM search_term_view WHERE ${filters.join(" AND ")} ORDER BY metrics.cost_micros DESC`;
      const { rows, nextPageToken, total } = await api.gaqlSearch(customer_id, query, { pageSize: limit, signal: ctx.mcpReq.signal });
      return renderRows(rows, response_format, { title: "Search terms", total, nextPageToken }, limit);
    }
  );
}

export { ResponseFormat };
