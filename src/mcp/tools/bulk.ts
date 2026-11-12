import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { normalizeCustomerId, type Ads, type GaqlRow } from "@/lib/ads";
import { customerIdField, gaqlString, text } from "@/lib/format";

/**
 * Bulk / repeating write tools. Same safety model as every write tool:
 *  - validate_only defaults to true (Google validates, nothing changes)
 *  - real changes need validate_only=false AND ALLOW_WRITES=true on the server
 *  - nothing here deletes anything; every executed call is audit-logged
 */
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const validateOnlyField = z.boolean().default(true).describe("true (default) = ask Google to validate only; NOTHING changes. Set false to apply for real.");

const banner = (validateOnly: boolean): string =>
  validateOnly ? "**VALIDATION ONLY: nothing was changed.** Call again with validate_only=false to apply." : "**APPLIED: the changes are live.**";

type Row = Record<string, Record<string, unknown> | undefined>;
const asRow = (r: GaqlRow): Row => r as Row;

// ---- helpers ----

interface PartialSummary {
  ok: number;
  failed: number;
  messages: string[];
}

function summarizePartial(res: unknown, count: number): PartialSummary {
  const r = res as { partialFailureError?: { message?: string; details?: { errors?: { message?: string; location?: { fieldPathElements?: { fieldName?: string; index?: string | number }[] } }[] }[] } };
  if (!r?.partialFailureError) return { ok: count, failed: 0, messages: [] };
  const failedIdx = new Set<number>();
  const messages: string[] = [];
  for (const d of r.partialFailureError.details ?? []) {
    for (const e of d.errors ?? []) {
      const idx = e.location?.fieldPathElements?.find(f => f.fieldName === "operations")?.index;
      if (idx !== undefined) failedIdx.add(Number(idx));
      if (e.message && messages.length < 5 && !messages.includes(e.message)) messages.push(e.message);
    }
  }
  const failed = failedIdx.size || 1;
  if (!messages.length && r.partialFailureError.message) messages.push(r.partialFailureError.message);
  return { ok: Math.max(count - failed, 0), failed, messages };
}

/** Runs operations in chunks with partial failure on, and totals the outcome. */
async function mutateChunks(api: Ads, customerId: string, service: string, ops: unknown[], validateOnly: boolean, signal: AbortSignal, size = 500): Promise<PartialSummary> {
  const total: PartialSummary = { ok: 0, failed: 0, messages: [] };
  for (let i = 0; i < ops.length; i += size) {
    const chunk = ops.slice(i, i + size);
    const res = await api.mutate(customerId, service, chunk, validateOnly, signal, { partialFailure: true });
    const s = summarizePartial(res, chunk.length);
    total.ok += s.ok;
    total.failed += s.failed;
    for (const m of s.messages) if (total.messages.length < 5 && !total.messages.includes(m)) total.messages.push(m);
  }
  return total;
}

function outcome(s: PartialSummary): string {
  return `${s.ok} OK, ${s.failed} failed${s.messages.length ? `\n  Problems: ${s.messages.join(" | ")}` : ""}`;
}

type MatchType = "EXACT" | "PHRASE" | "BROAD";

/** "[exact]" -> EXACT, "\"phrase\"" -> PHRASE, plain -> default. Returns null for unusable input. */
function parseKeyword(raw: string, def: MatchType): { text: string; matchType: MatchType } | null {
  let t = raw.trim();
  let matchType = def;
  const ex = /^\[(.+)\]$/.exec(t);
  const ph = /^"(.+)"$/.exec(t);
  if (ex) {
    t = ex[1];
    matchType = "EXACT";
  } else if (ph) {
    t = ph[1];
    matchType = "PHRASE";
  }
  t = t.trim().replace(/\s+/g, " ");
  if (!t || t.length > 80 || t.split(" ").length > 10) return null;
  return { text: t, matchType };
}

function dedupeKeywords(raw: string[], def: MatchType): { list: { text: string; matchType: MatchType }[]; invalid: string[] } {
  const seen = new Set<string>();
  const list: { text: string; matchType: MatchType }[] = [];
  const invalid: string[] = [];
  for (const r of raw) {
    const k = parseKeyword(r, def);
    if (!k) {
      invalid.push(r);
      continue;
    }
    const key = `${k.text.toLowerCase()}|${k.matchType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(k);
  }
  return { list, invalid };
}

const urls = (o: unknown): string[] => (Array.isArray(o) ? (o as string[]) : []);

const keyOf = (t: unknown, m: unknown): string => `${String(t).toLowerCase()}|${String(m)}`;

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

export function registerBulkTools(server: McpServer, api: Ads): void {
  // ---- Negative keywords (campaign / ad group / shared list / account) ----

  server.registerTool(
    "gads_add_negative_keywords",
    {
      title: "Add Negative Keywords (any level)",
      description: `Add negative keywords at any level, skipping ones that already exist. Replaces the old campaign-only tool.

scope:
  - campaign: negatives on one or more campaigns (campaign_ids). Works for Search; for PMax/Shopping campaigns Google may reject campaign-level keyword negatives.
  - ad_group: negatives on one or more ad groups (ad_group_ids).
  - shared_list: add to an EXISTING negative keyword list (shared_set_id, or list_name to look it up).
  - account: account-level negatives, stored in a negative keyword list that is attached to the whole account (list_name, default "Account-level negatives"; created and attached if missing). Works for all campaign types.

keywords: plain text uses match_type; write [exact] or "phrase" to set the match type per keyword. Max 80 chars / 10 words each.
customer_ids can hold up to 60 accounts for scope account or shared_list (by list_name): the same negatives are applied to each (the repeating batch case).

Typical flow: gads_report level=search_term (zero_conversions_only, min_cost) -> choose terms -> this tool with validate_only=true -> validate_only=false.`,
      inputSchema: z.strictObject({
        customer_ids: z.array(customerIdField).min(1).max(60),
        scope: z.enum(["campaign", "ad_group", "shared_list", "account"]),
        keywords: z.array(z.string().min(1).max(100)).min(1).max(1000),
        match_type: z.enum(["EXACT", "PHRASE", "BROAD"]).default("PHRASE").describe("Match type for keywords without [ ] or quotes"),
        campaign_ids: z.array(z.string().regex(/^\d+$/)).max(100).optional(),
        ad_group_ids: z.array(z.string().regex(/^\d+$/)).max(100).optional(),
        shared_set_id: z.string().regex(/^\d+$/).optional(),
        list_name: z.string().min(1).max(200).optional(),
        validate_only: validateOnlyField
      }),
      annotations: WRITE
    },
    async (a, ctx) => {
      const signal = ctx.mcpReq.signal;
      const { list, invalid } = dedupeKeywords(a.keywords, a.match_type);
      if (!list.length) return { isError: true, ...text(`No usable keywords. Invalid: ${invalid.join(", ")}`) };
      if (a.customer_ids.length > 1 && (a.scope === "campaign" || a.scope === "ad_group")) {
        return { isError: true, ...text("Several accounts are only supported for scope=account or scope=shared_list, because campaign and ad group IDs belong to one account.") };
      }
      if (a.scope === "campaign" && !a.campaign_ids?.length) return { isError: true, ...text("scope=campaign needs campaign_ids.") };
      if (a.scope === "ad_group" && !a.ad_group_ids?.length) return { isError: true, ...text("scope=ad_group needs ad_group_ids.") };
      if (a.scope === "shared_list" && !a.shared_set_id && !a.list_name) return { isError: true, ...text("scope=shared_list needs shared_set_id or list_name.") };

      const findList = async (customerId: string, name: string): Promise<string | null> => {
        const rows = await api.gaqlAll(customerId, `SELECT shared_set.id FROM shared_set WHERE shared_set.type = NEGATIVE_KEYWORDS AND shared_set.status = 'ENABLED' AND shared_set.name = '${gaqlString(name)}'`, { signal });
        return rows.length ? String(asRow(rows[0]).sharedSet?.id) : null;
      };

      const processAccount = async (customerId: string): Promise<string> => {
        const cid = normalizeCustomerId(customerId);
        try {
          if (a.scope === "campaign") {
            const existing = new Set<string>();
            const rows = await api.gaqlAll(cid, `SELECT campaign.id, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign_criterion.negative = TRUE AND campaign_criterion.type = KEYWORD AND campaign.id IN (${a.campaign_ids!.join(", ")})`, { signal });
            for (const r of rows.map(asRow)) existing.add(`${r.campaign?.id}|${keyOf((r.campaignCriterion?.keyword as Row | undefined)?.text, (r.campaignCriterion?.keyword as Row | undefined)?.matchType)}`);
            const ops: unknown[] = [];
            let skipped = 0;
            for (const camp of a.campaign_ids!) {
              for (const k of list) {
                if (existing.has(`${camp}|${keyOf(k.text, k.matchType)}`)) skipped++;
                else ops.push({ create: { campaign: `customers/${cid}/campaigns/${camp}`, negative: true, keyword: k } });
              }
            }
            if (!ops.length) return `${cid}: nothing to add (${skipped} already exist).`;
            const s = await mutateChunks(api, cid, "campaignCriteria", ops, a.validate_only, signal);
            return `${cid}: ${ops.length} negative(s) to ${a.campaign_ids!.length} campaign(s), ${skipped} already existed. ${outcome(s)}`;
          }

          if (a.scope === "ad_group") {
            const existing = new Set<string>();
            const rows = await api.gaqlAll(cid, `SELECT ad_group.id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion WHERE ad_group_criterion.negative = TRUE AND ad_group_criterion.type = KEYWORD AND ad_group.id IN (${a.ad_group_ids!.join(", ")})`, { signal });
            for (const r of rows.map(asRow)) existing.add(`${r.adGroup?.id}|${keyOf((r.adGroupCriterion?.keyword as Row | undefined)?.text, (r.adGroupCriterion?.keyword as Row | undefined)?.matchType)}`);
            const ops: unknown[] = [];
            let skipped = 0;
            for (const ag of a.ad_group_ids!) {
              for (const k of list) {
                if (existing.has(`${ag}|${keyOf(k.text, k.matchType)}`)) skipped++;
                else ops.push({ create: { adGroup: `customers/${cid}/adGroups/${ag}`, negative: true, keyword: k } });
              }
            }
            if (!ops.length) return `${cid}: nothing to add (${skipped} already exist).`;
            const s = await mutateChunks(api, cid, "adGroupCriteria", ops, a.validate_only, signal);
            return `${cid}: ${ops.length} negative(s) to ${a.ad_group_ids!.length} ad group(s), ${skipped} already existed. ${outcome(s)}`;
          }

          // shared_list and account both work through a shared negative keyword list
          const name = a.scope === "account" ? (a.list_name ?? "Account-level negatives") : a.list_name;
          let setId = a.scope === "shared_list" && a.shared_set_id ? a.shared_set_id : name ? await findList(cid, name) : null;
          if (!setId && a.scope === "shared_list") return `${cid}: list "${name}" not found (use gads_list_negatives scope=shared_lists to see lists).`;

          if (!setId) {
            // account scope, list does not exist yet: create + fill + attach atomically
            const temp = `customers/${cid}/sharedSets/-1`;
            const ops = [
              { sharedSetOperation: { create: { resourceName: temp, name, type: "NEGATIVE_KEYWORDS" } } },
              ...list.map(k => ({ sharedCriterionOperation: { create: { sharedSet: temp, keyword: k } } })),
              { customerNegativeCriterionOperation: { create: { negativeKeywordList: { sharedSet: temp } } } }
            ];
            await api.mutate(cid, "googleAds", ops, a.validate_only, signal);
            return `${cid}: created list "${name}" with ${list.length} keyword(s) and attached it to the account.`;
          }

          const rn = `customers/${cid}/sharedSets/${setId}`;
          const existing = new Set<string>();
          const rows = await api.gaqlAll(cid, `SELECT shared_criterion.keyword.text, shared_criterion.keyword.match_type FROM shared_criterion WHERE shared_set.id = ${setId}`, { signal });
          for (const r of rows.map(asRow)) existing.add(keyOf((r.sharedCriterion?.keyword as Row | undefined)?.text, (r.sharedCriterion?.keyword as Row | undefined)?.matchType));
          const fresh = list.filter(k => !existing.has(keyOf(k.text, k.matchType)));
          const ops: unknown[] = fresh.map(k => ({ sharedCriterionOperation: { create: { sharedSet: rn, keyword: k } } }));

          let attachNote = "";
          if (a.scope === "account") {
            const att = await api.gaqlAll(cid, "SELECT customer_negative_criterion.negative_keyword_list.shared_set FROM customer_negative_criterion WHERE customer_negative_criterion.type = NEGATIVE_KEYWORD_LIST", { signal });
            const attached = att.map(asRow).some(r => ((r.customerNegativeCriterion?.negativeKeywordList as Row | undefined)?.sharedSet as unknown as string) === rn);
            if (!attached) {
              ops.push({ customerNegativeCriterionOperation: { create: { negativeKeywordList: { sharedSet: rn } } } });
              attachNote = " Attached the list to the account.";
            }
          }
          if (!ops.length) return `${cid}: nothing to add (${list.length - fresh.length} already in the list).`;
          await api.mutate(cid, "googleAds", ops, a.validate_only, signal);
          return `${cid}: ${fresh.length} keyword(s) added to list ${setId}, ${list.length - fresh.length} already existed.${attachNote}`;
        } catch (error) {
          return `${cid}: FAILED - ${error instanceof Error ? error.message : String(error)}`;
        }
      };

      const results = await pool(a.customer_ids, 4, processAccount);
      const head = `${banner(a.validate_only)}\n\nScope: ${a.scope}. ${list.length} unique keyword(s)${invalid.length ? `, ${invalid.length} invalid skipped (${invalid.join(", ")})` : ""}.`;
      return text(`${head}\n\n${results.map(r => `- ${r}`).join("\n")}`);
    }
  );

  // ---- Add positive keywords ----

  server.registerTool(
    "gads_add_keywords",
    {
      title: "Add Keywords to an Ad Group",
      description: `Add (positive) keywords to one Search ad group, skipping ones already there. Use it to promote converting search terms to keywords.

Write [exact] or "phrase" per keyword, or use match_type for plain ones. Optional cpc_bid (account currency, only for manual bidding) and final_url.`,
      inputSchema: z.strictObject({
        customer_id: customerIdField,
        ad_group_id: z.string().regex(/^\d+$/),
        keywords: z.array(z.string().min(1).max(100)).min(1).max(500),
        match_type: z.enum(["EXACT", "PHRASE", "BROAD"]).default("EXACT"),
        cpc_bid: z.number().positive().max(10_000).optional(),
        final_url: z.url().optional(),
        validate_only: validateOnlyField
      }),
      annotations: WRITE
    },
    async (a, ctx) => {
      const signal = ctx.mcpReq.signal;
      const cid = normalizeCustomerId(a.customer_id);
      const { list, invalid } = dedupeKeywords(a.keywords, a.match_type);
      const rows = await api.gaqlAll(cid, `SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion WHERE ad_group.id = ${a.ad_group_id} AND ad_group_criterion.type = KEYWORD AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status != 'REMOVED'`, { signal });
      const existing = new Set(rows.map(asRow).map(r => keyOf((r.adGroupCriterion?.keyword as Row | undefined)?.text, (r.adGroupCriterion?.keyword as Row | undefined)?.matchType)));
      const fresh = list.filter(k => !existing.has(keyOf(k.text, k.matchType)));
      if (!fresh.length) return text(`Nothing to add: ${list.length} keyword(s) already exist in ad group ${a.ad_group_id}.`);
      const ops = fresh.map(k => ({
        create: {
          adGroup: `customers/${cid}/adGroups/${a.ad_group_id}`,
          status: "ENABLED",
          keyword: k,
          ...(a.cpc_bid ? { cpcBidMicros: String(Math.round(a.cpc_bid * 100) * 10_000) } : {}),
          ...(a.final_url ? { finalUrls: [a.final_url] } : {})
        }
      }));
      const s = await mutateChunks(api, cid, "adGroupCriteria", ops, a.validate_only, signal);
      return text(`${banner(a.validate_only)}\n\nAd group ${a.ad_group_id}: ${fresh.length} keyword(s) to add, ${list.length - fresh.length} already existed${invalid.length ? `, ${invalid.length} invalid` : ""}.\n${outcome(s)}\n${fresh.map(k => `- ${k.text} (${k.matchType})`).join("\n")}`);
    }
  );

  // ---- Bulk URL find & replace ----

  server.registerTool(
    "gads_bulk_replace_urls",
    {
      title: "Bulk Find & Replace in Landing Page URLs",
      description: `Find and replace text in final URLs (and mobile final URLs) across many items at once, e.g. mybos.com -> learn.mybos.com. Always shows a before/after preview first.

targets (any combination): ads | keywords | asset_groups (Performance Max) | assets (sitelink, promotion, price assets)
Optional campaign_ids narrows ads / keywords / asset_groups. Removed items are never touched. Literal text match (not regex), case-sensitive.
Changing URLs sends ads back for policy review. Defaults to validate_only=true.`,
      inputSchema: z.strictObject({
        customer_id: customerIdField,
        find: z.string().min(3).max(300),
        replace: z.string().max(300),
        targets: z.array(z.enum(["ads", "keywords", "asset_groups", "assets"])).min(1).default(["ads"]),
        campaign_ids: z.array(z.string().regex(/^\d+$/)).max(100).optional(),
        preview_rows: z.number().int().min(1).max(100).default(20),
        validate_only: validateOnlyField
      }),
      annotations: WRITE
    },
    async (a, ctx) => {
      const signal = ctx.mcpReq.signal;
      const cid = normalizeCustomerId(a.customer_id);
      const camp = a.campaign_ids?.length ? ` AND campaign.id IN (${a.campaign_ids.join(", ")})` : "";
      const swap = (urls: unknown): string[] | null => {
        if (!Array.isArray(urls) || !urls.length) return null;
        const before = urls as string[];
        const after = before.map(u => u.split(a.find).join(a.replace));
        return after.some((u, i) => u !== before[i]) ? after : null;
      };
      const validUrls = (urls: string[]): boolean => urls.every(u => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } });

      interface Change { target: string; id: string; service: string; op: unknown; before: string; after: string }
      const changes: Change[] = [];
      const skippedInvalid: string[] = [];

      const add = (target: string, id: string, service: string, rn: string, mask: string[], fields: Record<string, string[]>, before: string[], after: string[]) => {
        if (!validUrls(after)) {
          skippedInvalid.push(`${target} ${id}`);
          return;
        }
        changes.push({ target, id, service, op: { updateMask: mask.join(","), update: { resourceName: rn, ...fields } }, before: before.join(", "), after: after.join(", ") });
      };

      for (const target of a.targets) {
        if (target === "ads") {
          const rows = await api.gaqlAll(cid, `SELECT ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.final_urls, ad_group_ad.ad.final_mobile_urls FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED'${camp}`, { signal });
          const seen = new Set<string>();
          for (const r of rows.map(asRow)) {
            const ad = r.adGroupAd?.ad as Row | undefined;
            const id = String(ad?.id);
            if (seen.has(id)) continue; // the same ad can be in several ad groups only for shared ads
            const f = swap(ad?.finalUrls);
            const m = swap(ad?.finalMobileUrls);
            if (!f && !m) continue;
            seen.add(id);
            const mask = [...(f ? ["final_urls"] : []), ...(m ? ["final_mobile_urls"] : [])];
            add("ad", id, "ads", `customers/${cid}/ads/${id}`, mask, { ...(f ? { finalUrls: f } : {}), ...(m ? { finalMobileUrls: m } : {}) }, urls(ad?.finalUrls), f ?? urls(ad?.finalUrls));
          }
        } else if (target === "keywords") {
          const rows = await api.gaqlAll(cid, `SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.final_urls, ad_group_criterion.final_mobile_urls FROM ad_group_criterion WHERE ad_group_criterion.type = KEYWORD AND ad_group_criterion.status != 'REMOVED'${camp}`, { signal });
          for (const r of rows.map(asRow)) {
            const c = r.adGroupCriterion as Row | undefined;
            const f = swap(c?.finalUrls);
            const m = swap(c?.finalMobileUrls);
            if (!f && !m) continue;
            const id = `${r.adGroup?.id}~${c?.criterionId}`;
            const mask = [...(f ? ["final_urls"] : []), ...(m ? ["final_mobile_urls"] : [])];
            add("keyword", id, "adGroupCriteria", `customers/${cid}/adGroupCriteria/${id}`, mask, { ...(f ? { finalUrls: f } : {}), ...(m ? { finalMobileUrls: m } : {}) }, urls(c?.finalUrls), f ?? urls(c?.finalUrls));
          }
        } else if (target === "asset_groups") {
          const rows = await api.gaqlAll(cid, `SELECT asset_group.id, asset_group.final_urls, asset_group.final_mobile_urls FROM asset_group WHERE asset_group.status != 'REMOVED'${camp}`, { signal });
          for (const r of rows.map(asRow)) {
            const g = r.assetGroup as Row | undefined;
            const f = swap(g?.finalUrls);
            const m = swap(g?.finalMobileUrls);
            if (!f && !m) continue;
            const mask = [...(f ? ["final_urls"] : []), ...(m ? ["final_mobile_urls"] : [])];
            add("asset_group", String(g?.id), "assetGroups", String(g?.resourceName), mask, { ...(f ? { finalUrls: f } : {}), ...(m ? { finalMobileUrls: m } : {}) }, urls(g?.finalUrls), f ?? urls(g?.finalUrls));
          }
        } else {
          const rows = await api.gaqlAll(cid, "SELECT asset.id, asset.type, asset.final_urls, asset.final_mobile_urls FROM asset WHERE asset.type IN (SITELINK, PROMOTION, PRICE)", { signal });
          for (const r of rows.map(asRow)) {
            const s = r.asset as Row | undefined;
            const f = swap(s?.finalUrls);
            const m = swap(s?.finalMobileUrls);
            if (!f && !m) continue;
            const mask = [...(f ? ["final_urls"] : []), ...(m ? ["final_mobile_urls"] : [])];
            add(`asset(${s?.type})`, String(s?.id), "assets", String(s?.resourceName), mask, { ...(f ? { finalUrls: f } : {}), ...(m ? { finalMobileUrls: m } : {}) }, urls(s?.finalUrls), f ?? urls(s?.finalUrls));
          }
        }
      }

      if (!changes.length) return text(`No URLs containing "${a.find}" found in ${a.targets.join(", ")}.`);

      const byService = new Map<string, unknown[]>();
      for (const c of changes) byService.set(c.service, [...(byService.get(c.service) ?? []), c.op]);
      const lines: string[] = [];
      for (const [service, ops] of byService) {
        const s = await mutateChunks(api, cid, service, ops, a.validate_only, signal);
        lines.push(`- ${service}: ${ops.length} item(s): ${outcome(s)}`);
      }

      const preview = changes.slice(0, a.preview_rows).map(c => `- ${c.target} ${c.id}: ${c.before}  ->  ${c.after}`);
      return text(
        `${banner(a.validate_only)}\n\nReplace "${a.find}" with "${a.replace}": ${changes.length} item(s) affected.\n\n${lines.join("\n")}\n\nPreview (${preview.length} of ${changes.length}):\n${preview.join("\n")}${skippedInvalid.length ? `\n\nSkipped (result would not be a valid http(s) URL): ${skippedInvalid.slice(0, 10).join(", ")}` : ""}`
      );
    }
  );

  // ---- Bulk status ----

  server.registerTool(
    "gads_bulk_set_status",
    {
      title: "Bulk Pause / Enable",
      description: `Pause or enable many campaigns, ad groups, ads, keywords or asset groups in one call. Cannot remove anything.

ids format: campaign | ad_group | asset_group: the numeric ID. ad: "adGroupId~adId". keyword: "adGroupId~criterionId".
Items already in the target status are skipped. Defaults to validate_only=true.`,
      inputSchema: z.strictObject({
        customer_id: customerIdField,
        resource: z.enum(["campaign", "ad_group", "ad", "keyword", "asset_group"]),
        ids: z.array(z.string().regex(/^\d+(~\d+)?$/, "Use digits, or adGroupId~itemId for ads and keywords")).min(1).max(1000),
        status: z.enum(["ENABLED", "PAUSED"]),
        validate_only: validateOnlyField
      }),
      annotations: WRITE
    },
    async (a, ctx) => {
      const signal = ctx.mcpReq.signal;
      const cid = normalizeCustomerId(a.customer_id);
      const cfg = {
        campaign: { service: "campaigns", path: "campaigns", pair: false, from: "campaign", id: "campaign.id", name: "campaign.name", status: "campaign.status" },
        ad_group: { service: "adGroups", path: "adGroups", pair: false, from: "ad_group", id: "ad_group.id", name: "ad_group.name", status: "ad_group.status" },
        asset_group: { service: "assetGroups", path: "assetGroups", pair: false, from: "asset_group", id: "asset_group.id", name: "asset_group.name", status: "asset_group.status" },
        ad: { service: "adGroupAds", path: "adGroupAds", pair: true },
        keyword: { service: "adGroupCriteria", path: "adGroupCriteria", pair: true }
      }[a.resource] as { service: string; path: string; pair: boolean; from?: string; id?: string; name?: string; status?: string };

      const wantPair = cfg.pair;
      const badIds = a.ids.filter(i => i.includes("~") !== wantPair);
      if (badIds.length) return { isError: true, ...text(`Wrong ID format for ${a.resource}: ${badIds.slice(0, 5).join(", ")}. ${wantPair ? 'Use "adGroupId~itemId".' : "Use the numeric ID only."}`) };

      let ids = [...new Set(a.ids)];
      const info = new Map<string, { name: string; status: string }>();
      const missing: string[] = [];
      if (cfg.from) {
        for (let i = 0; i < ids.length; i += 200) {
          const chunk = ids.slice(i, i + 200);
          const rows = await api.gaqlAll(cid, `SELECT ${cfg.id}, ${cfg.name}, ${cfg.status} FROM ${cfg.from} WHERE ${cfg.id} IN (${chunk.join(", ")})`, { signal });
          for (const r of rows.map(asRow)) {
            const o = (r.campaign ?? r.adGroup ?? r.assetGroup) as Row | undefined;
            info.set(String(o?.id), { name: String(o?.name), status: String(o?.status) });
          }
        }
        missing.push(...ids.filter(id => !info.has(id)));
        ids = ids.filter(id => info.has(id) && info.get(id)!.status !== a.status && info.get(id)!.status !== "REMOVED");
      }
      if (!ids.length) return text(`Nothing to change: every item is already ${a.status}${missing.length ? ` (not found: ${missing.slice(0, 10).join(", ")})` : ""}.`);

      const ops = ids.map(id => ({ updateMask: "status", update: { resourceName: `customers/${cid}/${cfg.path}/${id}`, status: a.status } }));
      const s = await mutateChunks(api, cid, cfg.service, ops, a.validate_only, signal);
      const sample = ids.slice(0, 25).map(id => `- ${info.get(id)?.name ? `${info.get(id)!.name} (${id})` : id}${info.get(id) ? `: ${info.get(id)!.status} -> ${a.status}` : ""}`);
      return text(`${banner(a.validate_only)}\n\n${a.resource}: set ${ids.length} item(s) to ${a.status}. ${outcome(s)}${missing.length ? `\nNot found: ${missing.slice(0, 10).join(", ")}` : ""}\n\n${sample.join("\n")}${ids.length > 25 ? `\n... and ${ids.length - 25} more` : ""}`);
    }
  );
}
