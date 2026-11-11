import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { Ads } from "@/lib/ads";
import { customerIdField, jsonText, renderRows, ResponseFormat, responseFormatField, text } from "@/lib/format";

/**
 * Generic tools that cover the WHOLE Google Ads API surface:
 *  - gads_mutate:       create / update / remove on ANY resource (campaigns, ad groups, ads, keywords,
 *                       assets, asset groups, conversion actions, audiences, labels, bidding strategies ...)
 *  - gads_api_request:  any other REST endpoint (keyword ideas, uploads, recommendations, ...)
 *  - gads_list_fields:  discover every GAQL field/resource so queries and mutations can be built correctly
 * Same safety model as the shortcut tools: validate_only defaults to true, ALLOW_WRITES must be "true"
 * for real changes, removals need allow_remove=true, every executed call is audit-logged.
 */
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

const loginField = customerIdField.optional().describe("Override the manager (MCC) account used as login-customer-id for this call");

function hasRemove(op: Record<string, unknown>): boolean {
  if ("remove" in op) return true;
  // googleAds:mutate wraps each operation: { campaignOperation: { remove: "..." } }
  return Object.values(op).some(v => v !== null && typeof v === "object" && !Array.isArray(v) && "remove" in (v as object));
}

export function registerGenericTools(server: McpServer, api: Ads): void {
  server.registerTool(
    "gads_mutate",
    {
      title: "Mutate Any Google Ads Resource",
      description: `Create, update or remove ANY Google Ads resource through its <service>:mutate endpoint. This is the general-purpose write tool: use it for anything the shortcut tools don't cover.

service: REST mutate service in camelCase, e.g. campaigns, campaignBudgets, adGroups, adGroupAds, adGroupCriteria, campaignCriteria, ads, assets, assetGroups, assetGroupAssets, campaignAssets, conversionActions, biddingStrategies, sharedSets, sharedCriteria, labels, userLists, customerNegativeCriteria, customizerAttributes, campaignBidModifiers. Special cases: "customers" (account settings) and "googleAds" (atomic multi-resource batch; each operation is then wrapped, e.g. {"campaignOperation": {"update": {...}, "updateMask": "..."}}).

Operation shapes (JSON camelCase; int64 values as strings; enums as strings):
  create: {"create": { ...resource fields... }}
  update: {"update": {"resourceName": "customers/123/campaigns/456", "status": "PAUSED"}, "updateMask": "status"}   (updateMask is required, comma-separated snake_case field paths)
  remove: {"remove": "customers/123/adGroupCriteria/456~789"}   (needs allow_remove=true)

Use gads_list_fields to discover resource fields, and gads_run_gaql to read current values first. Defaults to validate-only: nothing changes until validate_only=false.`,
      inputSchema: z.strictObject({
        customer_id: customerIdField,
        service: z.string().regex(/^[a-zA-Z]+$/, "Service name is camelCase letters only, e.g. adGroupAds").describe("Mutate service name, e.g. 'campaigns' or 'assetGroups'"),
        operations: z.array(z.record(z.string(), z.unknown())).min(1).max(5000).describe("Operation objects (see tool description)"),
        partial_failure: z.boolean().default(false).describe("Apply valid operations even if others fail (default: all-or-nothing)"),
        allow_remove: z.boolean().default(false).describe("Required to run any 'remove' operation (deletes the resource)"),
        validate_only: z.boolean().default(true).describe("true (default) = Google validates only, NOTHING changes. false = apply for real."),
        login_customer_id: loginField
      }),
      annotations: WRITE
    },
    async ({ customer_id, service, operations, partial_failure, allow_remove, validate_only, login_customer_id }, ctx) => {
      if (operations.some(hasRemove) && !allow_remove) {
        return { isError: true, ...text("These operations include a 'remove' (delete). Re-run with allow_remove=true to confirm.") };
      }
      const result = await api.mutate(customer_id, service, operations, validate_only, ctx.mcpReq.signal, {
        partialFailure: partial_failure,
        loginCustomerId: login_customer_id
      });
      const banner = validate_only
        ? "**VALIDATION ONLY: nothing was changed.** Call again with validate_only=false to apply."
        : "**APPLIED: the change is live.**";
      return text(`${banner}\n\n${operations.length} operation(s) on ${service} for ${customer_id}.\n\nGoogle's response:\n${jsonText(result)}`);
    }
  );

  server.registerTool(
    "gads_api_request",
    {
      title: "Call Any Google Ads REST Endpoint",
      description: `Escape hatch for any Google Ads REST endpoint that the other tools don't wrap. 'path' is everything after the version, e.g.:
  - "customers/1234567890/keywordPlanIdeas:generateKeywordIdeas"   (keyword research, POST)
  - "customers/1234567890:uploadClickConversions"                    (offline conversions, POST)
  - "customers/1234567890/recommendations:apply"                     (apply recommendations, POST)
  - "customers/1234567890/googleAds:searchStream"                    (streaming GAQL, POST)
  - "customers:listAccessibleCustomers"                              (GET)

Reads (GET, and POST paths containing :search or :generate) run freely. Any other POST is a write: it needs confirm_write=true and the ALLOW_WRITES secret. Put "validateOnly": true in the body for endpoints that support it. Prefer gads_mutate for create/update/remove.`,
      inputSchema: z.strictObject({
        path: z
          .string()
          .regex(/^[A-Za-z0-9_\-/:.~]+$/, "Path may contain letters, digits and _-/:.~ only")
          .refine(p => !p.startsWith("/") && !p.includes(".."), "Path must be relative (no leading '/' or '..')")
          .describe("Endpoint path after the API version, e.g. 'customers/1234567890/keywordPlanIdeas:generateKeywordIdeas'"),
        method: z.enum(["GET", "POST"]).default("POST"),
        body: z.record(z.string(), z.unknown()).optional().describe("JSON request body (POST)"),
        confirm_write: z.boolean().default(false).describe("Required for POST endpoints that modify data"),
        login_customer_id: loginField
      }),
      annotations: WRITE
    },
    async ({ path, method, body, confirm_write, login_customer_id }, ctx) => {
      const isRead = method === "GET" || /:(search|searchStream|generate\w*)$/.test(path);
      if (!isRead) {
        if (!confirm_write) {
          return { isError: true, ...text(`POST ${path} looks like a write. Re-run with confirm_write=true (and put "validateOnly": true in the body first if the endpoint supports it).`) };
        }
        api.assertWritesAllowed(false);
      }
      const result = await api.adsFetch<unknown>(path, { method, body, loginCustomerId: login_customer_id, signal: ctx.mcpReq.signal });
      if (!isRead) await api.audit({ path, method, body });
      return text(jsonText(result));
    }
  );

  server.registerTool(
    "gads_list_fields",
    {
      title: "Discover Google Ads Fields",
      description: `List GAQL fields and resources from Google's field metadata, so you can build correct queries and mutations for anything in the API.

Examples:
  - prefix="campaign." -> every campaign field (selectable/filterable/sortable, data type)
  - prefix="asset_group" -> asset group resource and fields
  - category="RESOURCE" with no prefix -> list every resource you can query`,
      inputSchema: z.strictObject({
        prefix: z.string().regex(/^[a-z_.]*$/, "Lowercase letters, digits-free, '_' and '.' only").default("").describe("Field name prefix, e.g. 'campaign.' or 'ad_group_ad.ad.'"),
        category: z.enum(["RESOURCE", "ATTRIBUTE", "SEGMENT", "METRIC"]).optional().describe("Only this category"),
        limit: z.number().int().min(1).max(500).default(100),
        response_format: responseFormatField
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ prefix, category, limit, response_format }, ctx) => {
      const where = [prefix ? `name LIKE '${prefix}%'` : "", category ? `category = '${category}'` : ""].filter(Boolean).join(" AND ");
      const query = `SELECT name, category, data_type, selectable, filterable, sortable${where ? ` WHERE ${where}` : ""}`;
      const data = await api.adsFetch<{ results?: Record<string, unknown>[]; totalResultsCount?: string }>("googleAdsFields:search", {
        body: { query, pageSize: limit },
        loginCustomerId: null,
        signal: ctx.mcpReq.signal
      });
      return renderRows(data.results ?? [], response_format as ResponseFormat, { title: `Google Ads fields${prefix ? ` starting with '${prefix}'` : ""}`, total: data.totalResultsCount === undefined ? undefined : Number(data.totalResultsCount), truncated: false }, limit);
    }
  );
}

