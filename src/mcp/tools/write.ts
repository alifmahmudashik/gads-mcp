import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { normalizeCustomerId, type Ads } from "@/lib/ads";
import { campaignIdField, customerIdField, text } from "@/lib/format";

/**
 * Safety model for every write tool:
 *  1. validate_only defaults to true: Google validates the change and nothing is modified.
 *  2. A real change needs validate_only=false AND the ALLOW_WRITES secret set to "true".
 *  3. The result always shows before -> after, and every executed call is audit-logged.
 *  4. Nothing here can remove/delete campaigns, ads or budgets.
 */
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const validateOnlyField = z
  .boolean()
  .default(true)
  .describe("true (default) = ask Google to validate only; NOTHING is changed. Set false to actually apply the change.");

function banner(validateOnly: boolean): string {
  return validateOnly
    ? "**VALIDATION ONLY: nothing was changed.** Call again with validate_only=false to apply."
    : "**APPLIED: the change is live.**";
}

export function registerWriteTools(server: McpServer, api: Ads): void {
  server.registerTool(
    "gads_set_campaign_status",
    {
      title: "Pause / Enable Campaign",
      description: `Pause or enable a single campaign. Cannot remove campaigns.

Defaults to validate-only; set validate_only=false to apply. Example: "Pause campaign 123456 in account 123-456-7890".`,
      inputSchema: z.strictObject({
        customer_id: customerIdField,
        campaign_id: campaignIdField,
        status: z.enum(["ENABLED", "PAUSED"]).describe("New status"),
        validate_only: validateOnlyField
      }),
      annotations: WRITE
    },
    async ({ customer_id, campaign_id, status, validate_only }, ctx) => {
      const cid = normalizeCustomerId(customer_id);
      const { rows } = await api.gaqlSearch(customer_id, `SELECT campaign.name, campaign.status FROM campaign WHERE campaign.id = ${campaign_id}`, { signal: ctx.mcpReq.signal });
      const current = rows[0] as { campaign?: { name?: string; status?: string } } | undefined;
      if (!current) return { isError: true, ...text(`Campaign ${campaign_id} not found in account ${customer_id}. Use gads_campaign_performance to list campaign IDs.`) };
      if (current.campaign?.status === status) return text(`Campaign "${current.campaign?.name}" (${campaign_id}) is already ${status}. No change needed.`);

      await api.mutate(customer_id, "campaigns", [{ updateMask: "status", update: { resourceName: `customers/${cid}/campaigns/${campaign_id}`, status } }], validate_only, ctx.mcpReq.signal);
      return text(`${banner(validate_only)}\n\nCampaign "${current.campaign?.name}" (${campaign_id}): ${current.campaign?.status} -> ${status}`);
    }
  );

  server.registerTool(
    "gads_set_campaign_budget",
    {
      title: "Set Campaign Daily Budget",
      description: `Change a campaign's daily budget (in the account's currency units, e.g. 50 = 50.00).

Guards: refuses shared budgets unless allow_shared=true, and refuses increases above 50% unless allow_large_increase=true. Defaults to validate-only.`,
      inputSchema: z.strictObject({
        customer_id: customerIdField,
        campaign_id: campaignIdField,
        daily_budget: z.number().positive().max(1_000_000).describe("New daily budget in account currency units, e.g. 75.50"),
        allow_shared: z.boolean().default(false).describe("Allow editing a budget shared by several campaigns (affects all of them)"),
        allow_large_increase: z.boolean().default(false).describe("Allow an increase of more than 50%"),
        validate_only: validateOnlyField
      }),
      annotations: WRITE
    },
    async ({ customer_id, campaign_id, daily_budget, allow_shared, allow_large_increase, validate_only }, ctx) => {
      const { rows } = await api.gaqlSearch(
        customer_id,
        `SELECT campaign.name, campaign.campaign_budget, campaign_budget.amount_micros, campaign_budget.explicitly_shared FROM campaign WHERE campaign.id = ${campaign_id}`,
        { signal: ctx.mcpReq.signal }
      );
      const row = rows[0] as { campaign?: { name?: string; campaignBudget?: string }; campaignBudget?: { amountMicros?: string; explicitlyShared?: boolean } } | undefined;
      const budgetRn = row?.campaign?.campaignBudget;
      if (!row || !budgetRn) return { isError: true, ...text(`Campaign ${campaign_id} not found in account ${customer_id}.`) };

      const oldMicros = Number(row.campaignBudget?.amountMicros ?? 0);
      // Round to whole cents (10,000 micros): Google rejects finer amounts for most currencies
      const newMicros = Math.round(daily_budget * 100) * 10_000;

      if (row.campaignBudget?.explicitlyShared && !allow_shared) {
        return { isError: true, ...text(`This campaign uses a shared budget (${budgetRn}); changing it affects every campaign using it. Re-run with allow_shared=true if that is intended.`) };
      }
      if (oldMicros > 0 && newMicros > oldMicros * 1.5 && !allow_large_increase) {
        return { isError: true, ...text(`Refused: ${(oldMicros / 1e6).toFixed(2)} -> ${(newMicros / 1e6).toFixed(2)} is an increase of more than 50%. Re-run with allow_large_increase=true to confirm.`) };
      }

      await api.mutate(customer_id, "campaignBudgets", [{ updateMask: "amount_micros", update: { resourceName: budgetRn, amountMicros: String(newMicros) } }], validate_only, ctx.mcpReq.signal);
      return text(`${banner(validate_only)}\n\nCampaign "${row.campaign?.name}" (${campaign_id}) daily budget: ${(oldMicros / 1e6).toFixed(2)} -> ${(newMicros / 1e6).toFixed(2)}`);
    }
  );

  server.registerTool(
    "gads_add_campaign_negative_keywords",
    {
      title: "Add Campaign Negative Keywords",
      description: `Add campaign-level negative keywords to one Search campaign. Find candidates with gads_search_terms (zero_conversions_only=true).

Defaults to validate-only. Existing duplicates are not detected, so Google may reject exact duplicates.`,
      inputSchema: z.strictObject({
        customer_id: customerIdField,
        campaign_id: campaignIdField,
        keywords: z.array(z.string().min(1).max(80)).min(1).max(100).describe("Negative keyword texts, without match-type brackets/quotes"),
        match_type: z.enum(["EXACT", "PHRASE", "BROAD"]).default("PHRASE").describe("Match type for all keywords in this call"),
        validate_only: validateOnlyField
      }),
      annotations: WRITE
    },
    async ({ customer_id, campaign_id, keywords, match_type, validate_only }, ctx) => {
      const cid = normalizeCustomerId(customer_id);
      const operations = keywords.map(k => ({
        create: { campaign: `customers/${cid}/campaigns/${campaign_id}`, negative: true, keyword: { text: k.trim(), matchType: match_type } }
      }));
      await api.mutate(customer_id, "campaignCriteria", operations, validate_only, ctx.mcpReq.signal);
      return text(`${banner(validate_only)}\n\nCampaign ${campaign_id}: ${keywords.length} negative keyword(s), ${match_type} match:\n${keywords.map(k => `- ${k}`).join("\n")}`);
    }
  );

  server.registerTool(
    "gads_update_ad_final_urls",
    {
      title: "Update Ad Final URLs",
      description: `Replace the final (landing page) URLs of one ad. Useful for URL migrations (e.g. mybos.com -> learn.mybos.com).

Find ad_group_id and ad_id with gads_run_gaql: SELECT ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.final_urls FROM ad_group_ad. Changing a URL can send the ad back for policy review. Defaults to validate-only.`,
      inputSchema: z.strictObject({
        customer_id: customerIdField,
        ad_group_id: z.string().regex(/^\d+$/).describe("Ad group ID (digits)"),
        ad_id: z.string().regex(/^\d+$/).describe("Ad ID (digits)"),
        final_urls: z.array(z.url()).min(1).max(5).describe("New final URLs, e.g. ['https://learn.mybos.com/page']"),
        validate_only: validateOnlyField
      }),
      annotations: WRITE
    },
    async ({ customer_id, ad_group_id, ad_id, final_urls, validate_only }, ctx) => {
      const cid = normalizeCustomerId(customer_id);
      const { rows } = await api.gaqlSearch(
        customer_id,
        `SELECT ad_group_ad.ad.final_urls FROM ad_group_ad WHERE ad_group.id = ${ad_group_id} AND ad_group_ad.ad.id = ${ad_id}`,
        { signal: ctx.mcpReq.signal }
      );
      const row = rows[0] as { adGroupAd?: { ad?: { finalUrls?: string[] } } } | undefined;
      if (!row) return { isError: true, ...text(`Ad ${ad_id} not found in ad group ${ad_group_id}. Check the IDs with gads_run_gaql.`) };
      const before = row.adGroupAd?.ad?.finalUrls ?? [];

      await api.mutate(
        customer_id,
        "adGroupAds",
        [{ updateMask: "ad.final_urls", update: { resourceName: `customers/${cid}/adGroupAds/${ad_group_id}~${ad_id}`, ad: { finalUrls: final_urls } } }],
        validate_only,
        ctx.mcpReq.signal
      );
      return text(`${banner(validate_only)}\n\nAd ${ad_id} final URLs:\n- before: ${before.join(", ") || "(none)"}\n- after: ${final_urls.join(", ")}`);
    }
  );
}
