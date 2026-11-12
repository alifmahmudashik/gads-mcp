import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { Ads, GaqlRow } from "@/lib/ads";
import {
  customerIdField,
  dateClause,
  dateRangeField,
  endDateField,
  gaqlString,
  renderRows,
  ResponseFormat,
  responseFormatField,
  startDateField,
  text
} from "@/lib/format";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/** Report levels: the GAQL resource plus the identifying columns for each row. */
const LEVELS = {
  account: { from: "customer", fields: ["customer.id", "customer.descriptive_name"], status: null },
  campaign: { from: "campaign", fields: ["campaign.id", "campaign.name", "campaign.status", "campaign.advertising_channel_type"], status: "campaign.status" },
  ad_group: { from: "ad_group", fields: ["campaign.id", "campaign.name", "ad_group.id", "ad_group.name", "ad_group.status"], status: "ad_group.status" },
  ad: {
    from: "ad_group_ad",
    fields: ["campaign.name", "ad_group.id", "ad_group.name", "ad_group_ad.ad.id", "ad_group_ad.ad.type", "ad_group_ad.status", "ad_group_ad.ad.final_urls"],
    status: "ad_group_ad.status"
  },
  keyword: {
    from: "keyword_view",
    fields: [
      "campaign.name",
      "ad_group.name",
      "ad_group_criterion.criterion_id",
      "ad_group_criterion.keyword.text",
      "ad_group_criterion.keyword.match_type",
      "ad_group_criterion.status",
      "ad_group_criterion.quality_info.quality_score"
    ],
    status: "ad_group_criterion.status"
  },
  search_term: { from: "search_term_view", fields: ["search_term_view.search_term", "search_term_view.status", "campaign.id", "campaign.name", "ad_group.name"], status: null },
  pmax_search_term: { from: "campaign_search_term_view", fields: ["campaign_search_term_view.search_term", "campaign.id", "campaign.name"], status: null },
  asset_group: {
    from: "asset_group",
    fields: ["campaign.name", "asset_group.id", "asset_group.name", "asset_group.status", "asset_group.ad_strength", "asset_group.final_urls"],
    status: "asset_group.status"
  },
  landing_page: { from: "landing_page_view", fields: ["campaign.name", "landing_page_view.unexpanded_final_url"], status: null },
  geo: { from: "geographic_view", fields: ["campaign.name", "geographic_view.country_criterion_id", "geographic_view.location_type"], status: null }
} as const;
type Level = keyof typeof LEVELS;

const SEGMENTS = {
  date: ["segments.date"],
  week: ["segments.week"],
  month: ["segments.month"],
  quarter: ["segments.quarter"],
  day_of_week: ["segments.day_of_week"],
  hour: ["segments.hour"],
  device: ["segments.device"],
  network: ["segments.ad_network_type"],
  conversion_action: ["segments.conversion_action_name", "segments.conversion_action_category"]
} as const;
type Segment = keyof typeof SEGMENTS;

const TIME_SEGMENTS = new Set<Segment>(["date", "week", "month", "quarter"]);
const DEFAULT_METRICS = ["impressions", "clicks", "ctr", "average_cpc", "cost_micros", "conversions", "conversions_value", "cost_per_conversion", "all_conversions"];
const IMPRESSION_SHARE = ["search_impression_share", "search_top_impression_share", "search_budget_lost_impression_share", "search_rank_lost_impression_share"];
// Google only allows these metrics together with the conversion_action segment
const CONVERSION_ACTION_METRICS = ["conversions", "conversions_value", "all_conversions", "all_conversions_value", "view_through_conversions"];

const metricName = z.string().regex(/^[a-z][a-z0-9_]*$/, "Metric names are snake_case, e.g. cost_micros");

export function registerReportTools(server: McpServer, api: Ads): void {
  server.registerTool(
    "gads_report",
    {
      title: "Flexible Performance Report",
      description: `One report tool for (almost) every performance question. Pick a level, optionally split by segments, and filter.

level: account | campaign | ad_group | ad | keyword | search_term | pmax_search_term | asset_group | landing_page | geo
segments (any combination): date | week | month | quarter | day_of_week | hour | device | network | conversion_action
  - device = Mobile / Desktop / Tablet; conversion_action = conversions split by each conversion action (name + category).
  - With segment conversion_action Google only allows conversion metrics (conversions, conversions_value, all_conversions, all_conversions_value, view_through_conversions); cost and clicks are not available together with it, so run a second report without it.
metrics: defaults to impressions, clicks, ctr, average_cpc, cost, conversions, conversions_value, cost_per_conversion, all_conversions. Pass metrics=[...] for any other GAQL metric (e.g. "conversions_from_interactions_rate", "absolute_top_impression_percentage"). include_impression_share adds the search impression share metrics.
Filters: campaign_ids, min_cost, min_clicks, zero_conversions_only, enabled_only, and where (extra GAQL conditions, e.g. "campaign.name LIKE '%Brand%'").

Costs are in account currency units. Rows are sorted chronologically when a time segment is used, otherwise by cost (or conversions). Use offset to page through long reports.

Examples:
  - "Conversions by device last 30 days": level=campaign, segments=[device]
  - "Which conversion actions fired": level=account, segments=[conversion_action]
  - "Best hours": level=account, segments=[hour]
  - "Daily trend": level=campaign, segments=[date]`,
      inputSchema: z.strictObject({
        customer_id: customerIdField,
        level: z.enum(Object.keys(LEVELS) as [Level, ...Level[]]).default("campaign"),
        segments: z.array(z.enum(Object.keys(SEGMENTS) as [Segment, ...Segment[]])).max(4).default([]),
        metrics: z.array(metricName).max(25).optional(),
        include_impression_share: z.boolean().default(false),
        date_range: dateRangeField,
        start_date: startDateField,
        end_date: endDateField,
        campaign_ids: z.array(z.string().regex(/^\d+$/)).max(100).optional(),
        enabled_only: z.boolean().default(false).describe("Only currently enabled campaigns / ad groups / ads / keywords"),
        include_inactive_rows: z.boolean().default(false).describe("Also show rows with zero impressions"),
        min_cost: z.number().min(0).optional().describe("Only rows with at least this cost (currency units)"),
        min_clicks: z.number().int().min(0).optional(),
        zero_conversions_only: z.boolean().default(false),
        where: z.string().max(500).regex(/^[^;]*$/, "No semicolons").optional().describe("Extra GAQL WHERE conditions joined with AND"),
        order_by: metricName.optional().describe("Metric to sort by (descending), e.g. conversions"),
        limit: z.number().int().min(1).max(1000).default(100),
        offset: z.number().int().min(0).default(0),
        response_format: responseFormatField
      }),
      annotations: READ_ONLY
    },
    async (a, ctx) => {
      const level = LEVELS[a.level];
      const segs = [...new Set(a.segments)];
      const byAction = segs.includes("conversion_action");

      let metrics = a.metrics?.length ? [...a.metrics] : byAction ? ["conversions", "conversions_value", "all_conversions", "all_conversions_value"] : [...DEFAULT_METRICS];
      if (a.include_impression_share && !byAction) metrics.push(...IMPRESSION_SHARE);
      metrics = [...new Set(metrics)];
      if (byAction) {
        const bad = metrics.filter(m => !CONVERSION_ACTION_METRICS.includes(m));
        if (bad.length) return { isError: true, ...text(`With segment conversion_action Google only allows: ${CONVERSION_ACTION_METRICS.join(", ")}. Remove: ${bad.join(", ")}, or run the report without that segment.`) };
        if (a.min_cost !== undefined || a.min_clicks !== undefined) return { isError: true, ...text("min_cost / min_clicks can't be combined with the conversion_action segment.") };
      }

      const select = [...level.fields, ...segs.flatMap(s => SEGMENTS[s]), ...metrics.map(m => `metrics.${m}`)];
      const where = [dateClause(a.date_range, a.start_date, a.end_date)];
      if (level.status) where.push(a.enabled_only ? `${level.status} = 'ENABLED'` : `${level.status} != 'REMOVED'`);
      if (a.campaign_ids?.length && a.level !== "account") where.push(`campaign.id IN (${a.campaign_ids.join(", ")})`);
      if (!a.include_inactive_rows && !byAction && metrics.includes("impressions")) where.push("metrics.impressions > 0");
      if (a.min_cost !== undefined) where.push(`metrics.cost_micros >= ${Math.round(a.min_cost * 1_000_000)}`);
      if (a.min_clicks !== undefined) where.push(`metrics.clicks >= ${a.min_clicks}`);
      if (a.zero_conversions_only) where.push("metrics.conversions = 0");
      if (a.where?.trim()) where.push(`(${a.where.trim()})`);

      const timeSeg = segs.find(s => TIME_SEGMENTS.has(s));
      let order: string;
      if (timeSeg) order = `${SEGMENTS[timeSeg][0]} ASC`;
      else {
        const col = a.order_by ?? (metrics.includes("cost_micros") ? "cost_micros" : metrics.includes("conversions") ? "conversions" : metrics[0]);
        order = `metrics.${col === "cost" ? "cost_micros" : col} DESC`;
      }

      const query = `SELECT ${select.join(", ")} FROM ${level.from} WHERE ${where.join(" AND ")} ORDER BY ${order}`;
      const rows = await api.gaqlAll(a.customer_id, query, { maxPages: 5, signal: ctx.mcpReq.signal });
      const page = rows.slice(a.offset);
      const title = `${a.level} report${segs.length ? ` by ${segs.join(" + ")}` : ""} (${a.start_date && a.end_date ? `${a.start_date} to ${a.end_date}` : a.date_range})`;
      const res = renderRows(page, a.response_format as ResponseFormat, { title, total: rows.length }, a.limit);
      if (a.response_format !== ResponseFormat.JSON && rows.length > a.offset + a.limit) {
        res.content[0].text += `\n\n${rows.length} rows in total. For the next rows call again with offset=${a.offset + a.limit} (output may show fewer rows if it hit the size cap).`;
      }
      return res;
    }
  );

  // ---- Period comparison ----

  const DAY = 86_400_000;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
  const daysBetween = (s: string, e: string) => Math.round((Date.parse(e) - Date.parse(s)) / DAY) + 1;

  function presetRanges(preset: string): { a: [string, string]; b: [string, string] } {
    const today = new Date(`${iso(new Date())}T00:00:00Z`);
    if (preset === "this_month_vs_last_month") {
      const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      const prevFirst = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
      return { a: [iso(prevFirst), iso(addDays(first, -1))], b: [iso(first), iso(today)] };
    }
    const n = preset === "last_7_vs_previous_7" ? 7 : 30;
    const bEnd = addDays(today, -1);
    const bStart = addDays(bEnd, -(n - 1));
    return { a: [iso(addDays(bStart, -n)), iso(addDays(bStart, -1))], b: [iso(bStart), iso(bEnd)] };
  }

  const pct = (from: number, to: number): string => (from === 0 ? (to === 0 ? "0%" : "new") : `${(((to - from) / from) * 100).toFixed(0)}%`);
  const n2 = (v: number): string => (Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)) : "-");

  interface Agg {
    name: string;
    imp: number;
    clicks: number;
    cost: number;
    conv: number;
    value: number;
  }

  server.registerTool(
    "gads_compare_periods",
    {
      title: "Compare Two Periods",
      description: `Compare performance between two date ranges (e.g. "why did this month drop vs last month?"), normalised per day so unequal period lengths don't mislead.

Shows, per account / campaign / ad group: cost, clicks, impressions, CTR, CPC, conversions, conversion rate, CPA, value and ROAS per day for period A (baseline) and period B (current), with % change, plus an account total. Sorted by the biggest spend.

Use preset (this_month_vs_last_month | last_7_vs_previous_7 | last_30_vs_previous_30) or give both ranges explicitly.`,
      inputSchema: z.strictObject({
        customer_id: customerIdField,
        level: z.enum(["account", "campaign", "ad_group"]).default("campaign"),
        preset: z.enum(["this_month_vs_last_month", "last_7_vs_previous_7", "last_30_vs_previous_30"]).optional(),
        a_start: startDateField.describe("Baseline period start, YYYY-MM-DD"),
        a_end: endDateField.describe("Baseline period end"),
        b_start: startDateField.describe("Current period start"),
        b_end: endDateField.describe("Current period end"),
        limit: z.number().int().min(1).max(100).default(25)
      }),
      annotations: READ_ONLY
    },
    async ({ customer_id, level, preset, a_start, a_end, b_start, b_end, limit }, ctx) => {
      let A: [string, string];
      let B: [string, string];
      if (preset) {
        const r = presetRanges(preset);
        A = r.a;
        B = r.b;
      } else if (a_start && a_end && b_start && b_end) {
        A = [a_start, a_end];
        B = [b_start, b_end];
      } else return { isError: true, ...text("Give a preset, or all four dates: a_start, a_end, b_start, b_end.") };

      const cfg = {
        account: { from: "customer", id: "customer.id", name: "customer.descriptive_name", where: "" },
        campaign: { from: "campaign", id: "campaign.id", name: "campaign.name", where: " AND campaign.status != 'REMOVED'" },
        ad_group: { from: "ad_group", id: "ad_group.id", name: "ad_group.name", where: " AND ad_group.status != 'REMOVED'" }
      }[level];

      const fetchPeriod = async (range: [string, string]): Promise<Map<string, Agg>> => {
        const q = `SELECT ${cfg.id}, ${cfg.name}, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM ${cfg.from} WHERE segments.date BETWEEN '${range[0]}' AND '${range[1]}'${cfg.where}`;
        const rows = await api.gaqlAll(customer_id, q, { maxPages: 5, signal: ctx.mcpReq.signal });
        const map = new Map<string, Agg>();
        for (const row of rows as GaqlRow[]) {
          const r = row as Record<string, Record<string, unknown>>;
          const key = String(level === "account" ? r.customer?.id : level === "campaign" ? r.campaign?.id : r.adGroup?.id);
          const name = String(level === "account" ? r.customer?.descriptiveName : level === "campaign" ? r.campaign?.name : r.adGroup?.name);
          const cur = map.get(key) ?? { name, imp: 0, clicks: 0, cost: 0, conv: 0, value: 0 };
          cur.imp += Number(r.metrics?.impressions ?? 0);
          cur.clicks += Number(r.metrics?.clicks ?? 0);
          cur.cost += Number(r.metrics?.costMicros ?? 0) / 1e6;
          cur.conv += Number(r.metrics?.conversions ?? 0);
          cur.value += Number(r.metrics?.conversionsValue ?? 0);
          map.set(key, cur);
        }
        return map;
      };

      const [ma, mb] = await Promise.all([fetchPeriod(A), fetchPeriod(B)]);
      const da = daysBetween(...A);
      const db = daysBetween(...B);
      const keys = new Set([...ma.keys(), ...mb.keys()]);
      const zero = (name: string): Agg => ({ name, imp: 0, clicks: 0, cost: 0, conv: 0, value: 0 });

      const entries = [...keys]
        .map(k => ({ k, a: ma.get(k) ?? zero(mb.get(k)?.name ?? k), b: mb.get(k) ?? zero(ma.get(k)?.name ?? k) }))
        .filter(e => e.a.cost + e.b.cost + e.a.clicks + e.b.clicks > 0)
        .sort((x, y) => y.a.cost / da + y.b.cost / db - (x.a.cost / da + x.b.cost / db));

      const total = (m: Map<string, Agg>): Agg => [...m.values()].reduce((t, v) => ({ name: "TOTAL", imp: t.imp + v.imp, clicks: t.clicks + v.clicks, cost: t.cost + v.cost, conv: t.conv + v.conv, value: t.value + v.value }), zero("TOTAL"));

      const lines: string[] = [];
      const block = (title: string, x: Agg, y: Agg) => {
        const pd = (v: number, d: number) => v / d;
        const metrics: [string, number, number, boolean][] = [
          ["Cost / day", pd(x.cost, da), pd(y.cost, db), true],
          ["Clicks / day", pd(x.clicks, da), pd(y.clicks, db), true],
          ["Impressions / day", pd(x.imp, da), pd(y.imp, db), true],
          ["CTR %", x.imp ? (x.clicks / x.imp) * 100 : 0, y.imp ? (y.clicks / y.imp) * 100 : 0, true],
          ["Avg CPC", x.clicks ? x.cost / x.clicks : 0, y.clicks ? y.cost / y.clicks : 0, true],
          ["Conversions / day", pd(x.conv, da), pd(y.conv, db), true],
          ["Conv rate %", x.clicks ? (x.conv / x.clicks) * 100 : 0, y.clicks ? (y.conv / y.clicks) * 100 : 0, true],
          ["Cost / conversion", x.conv ? x.cost / x.conv : 0, y.conv ? y.cost / y.conv : 0, true],
          ["Conv value / day", pd(x.value, da), pd(y.value, db), true],
          ["ROAS", x.cost ? x.value / x.cost : 0, y.cost ? y.value / y.cost : 0, true]
        ];
        lines.push(`**${title}**`, "", "| Metric | A | B | Change |", "| --- | --- | --- | --- |");
        for (const [label, va, vb] of metrics) lines.push(`| ${label} | ${n2(va)} | ${n2(vb)} | ${pct(va, vb)} |`);
        lines.push("");
      };

      lines.push(`# Period comparison (${level})`, `A (baseline): ${A[0]} to ${A[1]} (${da} days)`, `B (current): ${B[0]} to ${B[1]} (${db} days)`, "Values are per day unless noted; costs in account currency.", "");
      block("TOTAL", total(ma), total(mb));
      if (level !== "account") {
        for (const e of entries.slice(0, limit)) block(`${e.a.name || e.b.name} (${e.k})`, e.a, e.b);
        if (entries.length > limit) lines.push(`_${entries.length - limit} more rows not shown; raise limit._`);
      }
      return text(lines.join("\n"));
    }
  );

  // ---- Conversion actions ----

  server.registerTool(
    "gads_conversion_actions",
    {
      title: "Conversion Actions & Settings",
      description: `List every conversion action in an account with its settings: type, category, status, whether it counts in the "Conversions" column (include_in_conversions_metric / primary_for_goal), counting type, attribution model, default value and lookback window.

Use it to understand what is being counted as a conversion (for example shopping-app engagement vs real purchases). For performance split by conversion action use gads_report with segments=[conversion_action].`,
      inputSchema: z.strictObject({
        customer_id: customerIdField,
        include_removed: z.boolean().default(false),
        response_format: responseFormatField
      }),
      annotations: READ_ONLY
    },
    async ({ customer_id, include_removed, response_format }, ctx) => {
      const q = `SELECT conversion_action.id, conversion_action.name, conversion_action.type, conversion_action.category, conversion_action.status, conversion_action.primary_for_goal, conversion_action.include_in_conversions_metric, conversion_action.counting_type, conversion_action.attribution_model_settings.attribution_model, conversion_action.value_settings.default_value, conversion_action.value_settings.always_use_default_value, conversion_action.click_through_lookback_window_days, conversion_action.view_through_lookback_window_days FROM conversion_action${include_removed ? "" : " WHERE conversion_action.status != 'REMOVED'"} ORDER BY conversion_action.name`;
      const rows = await api.gaqlAll(customer_id, q, { signal: ctx.mcpReq.signal });
      return renderRows(rows, response_format as ResponseFormat, { title: "Conversion actions" }, 300);
    }
  );

  // ---- Change history ----

  server.registerTool(
    "gads_change_history",
    {
      title: "Change History",
      description: `Who changed what and when in an account (campaign/ad group/ad/budget/bid/asset edits). Google only keeps the last 30 days.

Use it to explain performance changes: budget or bid-strategy edits, paused campaigns, new assets. include_values adds old/new values of the changed fields.`,
      inputSchema: z.strictObject({
        customer_id: customerIdField,
        days: z.number().int().min(1).max(29).default(14).describe("How many days back (max 29)"),
        resource_type: z.string().regex(/^[A-Z_]+$/).optional().describe("e.g. CAMPAIGN, CAMPAIGN_BUDGET, AD_GROUP, AD_GROUP_AD, AD_GROUP_CRITERION, CAMPAIGN_CRITERION, ASSET, ASSET_GROUP, SHARED_SET"),
        user_email: z.string().max(100).optional(),
        campaign_id: z.string().regex(/^\d+$/).optional(),
        include_values: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(100),
        response_format: responseFormatField
      }),
      annotations: READ_ONLY
    },
    async ({ customer_id, days, resource_type, user_email, campaign_id, include_values, limit, response_format }, ctx) => {
      const now = new Date();
      const start = iso(addDays(now, -days));
      const end = iso(addDays(now, 1));
      const where = [`change_event.change_date_time >= '${start}'`, `change_event.change_date_time <= '${end}'`];
      if (resource_type) where.push(`change_event.change_resource_type = '${resource_type}'`);
      if (user_email) where.push(`change_event.user_email = '${gaqlString(user_email)}'`);
      if (campaign_id) where.push(`change_event.campaign = 'customers/${customer_id.replace(/-/g, "")}/campaigns/${campaign_id}'`);
      const cols = [
        "change_event.change_date_time",
        "change_event.user_email",
        "change_event.client_type",
        "change_event.change_resource_type",
        "change_event.resource_change_operation",
        "change_event.changed_fields",
        "change_event.change_resource_name",
        "change_event.campaign",
        "change_event.ad_group",
        ...(include_values ? ["change_event.old_resource", "change_event.new_resource"] : [])
      ];
      const q = `SELECT ${cols.join(", ")} FROM change_event WHERE ${where.join(" AND ")} ORDER BY change_event.change_date_time DESC LIMIT ${Math.min(limit * 2, 1000)}`;
      const { rows } = await api.gaqlSearch(customer_id, q, { signal: ctx.mcpReq.signal });
      return renderRows(rows, response_format as ResponseFormat, { title: `Changes in the last ${days} days` }, limit);
    }
  );

  // ---- Negatives overview ----

  server.registerTool(
    "gads_list_negatives",
    {
      title: "List Negative Keywords",
      description: `Read existing negative keywords so you can avoid duplicates and audit coverage.

scope: campaign (campaign-level negatives) | ad_group | shared_lists (negative keyword lists + member counts) | shared_list_keywords (the keywords inside one list; needs shared_set_id) | account_lists (lists attached at account level) | list_attachments (which campaigns use which lists).`,
      inputSchema: z.strictObject({
        customer_id: customerIdField,
        scope: z.enum(["campaign", "ad_group", "shared_lists", "shared_list_keywords", "account_lists", "list_attachments"]),
        campaign_ids: z.array(z.string().regex(/^\d+$/)).max(100).optional(),
        shared_set_id: z.string().regex(/^\d+$/).optional(),
        contains: z.string().max(80).optional().describe("Only keywords containing this text"),
        limit: z.number().int().min(1).max(1000).default(200),
        response_format: responseFormatField
      }),
      annotations: READ_ONLY
    },
    async ({ customer_id, scope, campaign_ids, shared_set_id, contains, limit, response_format }, ctx) => {
      const camp = campaign_ids?.length ? ` AND campaign.id IN (${campaign_ids.join(", ")})` : "";
      let q: string;
      let kwPath = "";
      switch (scope) {
        case "campaign":
          kwPath = "campaign_criterion.keyword.text";
          q = `SELECT campaign.id, campaign.name, campaign_criterion.criterion_id, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign_criterion.negative = TRUE AND campaign_criterion.type = KEYWORD${camp}`;
          break;
        case "ad_group":
          kwPath = "ad_group_criterion.keyword.text";
          q = `SELECT campaign.name, ad_group.id, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion WHERE ad_group_criterion.negative = TRUE AND ad_group_criterion.type = KEYWORD${camp}`;
          break;
        case "shared_lists":
          q = "SELECT shared_set.id, shared_set.name, shared_set.type, shared_set.status, shared_set.member_count, shared_set.reference_count FROM shared_set WHERE shared_set.type IN (NEGATIVE_KEYWORDS, ACCOUNT_LEVEL_NEGATIVE_KEYWORDS) AND shared_set.status != 'REMOVED' ORDER BY shared_set.name";
          break;
        case "shared_list_keywords":
          if (!shared_set_id) return { isError: true, ...text("shared_set_id is required for shared_list_keywords. Get it from scope=shared_lists.") };
          kwPath = "shared_criterion.keyword.text";
          q = `SELECT shared_set.name, shared_criterion.criterion_id, shared_criterion.keyword.text, shared_criterion.keyword.match_type FROM shared_criterion WHERE shared_set.id = ${shared_set_id}`;
          break;
        case "account_lists":
          q = "SELECT customer_negative_criterion.id, customer_negative_criterion.negative_keyword_list.shared_set FROM customer_negative_criterion WHERE customer_negative_criterion.type = NEGATIVE_KEYWORD_LIST";
          break;
        default:
          q = `SELECT campaign.id, campaign.name, shared_set.id, shared_set.name, campaign_shared_set.status FROM campaign_shared_set WHERE shared_set.type = NEGATIVE_KEYWORDS AND campaign_shared_set.status != 'REMOVED'${camp}`;
      }
      if (contains && kwPath) q += ` AND ${kwPath} LIKE '%${gaqlString(contains)}%'`;
      const rows = await api.gaqlAll(customer_id, q, { maxPages: 5, signal: ctx.mcpReq.signal });
      return renderRows(rows, response_format as ResponseFormat, { title: `Negatives: ${scope}`, total: rows.length }, limit);
    }
  );
}
