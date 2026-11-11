import * as z from "zod/v4";
import { CHARACTER_LIMIT } from "./env";
import type { GaqlRow } from "./ads";

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json"
}

export const responseFormatField = z
  .enum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("'markdown' for readable tables, 'json' for structured data");

export const customerIdField = z
  .string()
  .regex(/^\d{3}-?\d{3}-?\d{4}$/, "Customer ID must be 10 digits, with or without dashes")
  .describe("Google Ads customer ID (10 digits, dashes optional), e.g. '123-456-7890'");

export const campaignIdField = z.string().regex(/^\d+$/, "Campaign ID must be digits only").describe("Campaign ID (digits)");

export const dateRangeField = z
  .enum(["TODAY", "YESTERDAY", "LAST_7_DAYS", "LAST_14_DAYS", "LAST_30_DAYS", "THIS_MONTH", "LAST_MONTH"])
  .default("LAST_30_DAYS")
  .describe("Predefined date range. Ignored when both start_date and end_date are given.");

export const startDateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Custom range start, YYYY-MM-DD");
export const endDateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Custom range end, YYYY-MM-DD");

/** Builds a GAQL date predicate. All inputs are validated by the schemas above. */
export function dateClause(range: string, start?: string, end?: string): string {
  if (start && end) return `segments.date BETWEEN '${start}' AND '${end}'`;
  return `segments.date DURING ${range}`;
}

// ---- Row flattening ----

type Flat = Record<string, string | number | boolean | null>;

// Fields that Google returns in micros (1,000,000 = 1 currency unit) without "Micros" in the name
const MICROS_KEYS = new Set(["averageCpc", "averageCpm", "averageCost", "costPerConversion", "costPerAllConversions"]);

export function flattenRow(row: GaqlRow, prefix = ""): Flat {
  const out: Flat = {};
  for (const [key, value] of Object.entries(row)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flattenRow(value as GaqlRow, path));
    } else if (Array.isArray(value)) {
      out[path] = JSON.stringify(value);
    } else if ((key.endsWith("Micros") || MICROS_KEYS.has(key)) && value !== null && value !== "" && !Number.isNaN(Number(value))) {
      const name = key.endsWith("Micros") ? path.slice(0, -"Micros".length) : path;
      out[name] = Math.round((Number(value) / 1_000_000) * 100) / 100;
    } else {
      out[path] = value as string | number | boolean | null;
    }
  }
  return out;
}

function toMarkdownTable(rows: Flat[]): string {
  if (rows.length === 0) return "_No rows._";
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const esc = (v: unknown) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| ${cols.join(" | ")} |`,
    `| ${cols.map(() => "---").join(" | ")} |`,
    ...rows.map(r => `| ${cols.map(c => esc(r[c])).join(" | ")} |`)
  ].join("\n");
}

export interface PageMeta {
  title: string;
  total?: number;
  nextPageToken?: string;
  /** True when rows were dropped locally (limit / size cap) without a page token to continue */
  truncated?: boolean;
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
}

/** Renders rows as markdown or JSON, halving the row count until the text fits CHARACTER_LIMIT. */
export function renderRows(rawRows: GaqlRow[], format: ResponseFormat, meta: PageMeta, limit: number): ToolResult {
  const all = rawRows.map(r => flattenRow(r));
  let rows = all.slice(0, limit);

  const build = (shown: Flat[]) => {
    const droppedLocally = shown.length < all.length;
    const page = {
      title: meta.title,
      total: meta.total ?? all.length,
      count: shown.length,
      rows: shown,
      has_more: Boolean(meta.nextPageToken) || droppedLocally,
      ...(meta.nextPageToken && !droppedLocally ? { next_page_token: meta.nextPageToken } : {})
    };
    if (format === ResponseFormat.JSON) return { page, text: JSON.stringify(page, null, 2) };
    const lines = [`# ${meta.title}`, `Showing ${shown.length} of ${page.total} rows.`, "", toMarkdownTable(shown)];
    if (page.next_page_token) lines.push("", `More rows: call again with page_token="${page.next_page_token}".`);
    else if (droppedLocally) lines.push("", "More rows exist but were not returned: narrow the query (WHERE / LIMIT) or lower the columns.");
    return { page, text: lines.join("\n") };
  };

  let result = build(rows);
  while (rows.length > 1 && result.text.length > CHARACTER_LIMIT) {
    rows = rows.slice(0, Math.ceil(rows.length / 2));
    result = build(rows);
  }
  if (format === ResponseFormat.JSON) return { content: [{ type: "text", text: result.text }], structuredContent: result.page };
  return { content: [{ type: "text", text: result.text }] };
}

export function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

/** Pretty JSON for arbitrary API responses, capped at CHARACTER_LIMIT. */
export function jsonText(value: unknown): string {
  const t = JSON.stringify(value, null, 2) ?? "null";
  return t.length > CHARACTER_LIMIT ? `${t.slice(0, CHARACTER_LIMIT)}\n... [truncated: response exceeded ${CHARACTER_LIMIT} characters; narrow the request]` : t;
}
