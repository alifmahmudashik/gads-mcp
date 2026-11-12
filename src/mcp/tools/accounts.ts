import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { Ads } from "@/lib/ads";
import { renderRows, ResponseFormat, responseFormatField } from "@/lib/format";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export function registerAccountTools(server: McpServer, api: Ads): void {
  server.registerTool(
    "gads_find_account",
    {
      title: "Find Google Ads Account",
      description: `Find any Google Ads account you can reach, by name or ID, across ALL your manager (MCC) accounts at once.

You never need to say which MCC an account is under: every other tool routes through the right MCC automatically. Use this to turn a client name ("Ace Vending") into a customer ID, or to list everything with no query.

Examples: query="ace" | query="4122790482" | no query (list all accounts, managers included).`,
      inputSchema: z.strictObject({
        query: z.string().max(100).optional().describe("Part of the account name, or the customer ID (dashes optional). Omit to list all."),
        include_inactive: z.boolean().default(false).describe("Include canceled / suspended accounts"),
        include_managers: z.boolean().default(true).describe("Include manager (MCC) accounts"),
        refresh: z.boolean().default(false).describe("Re-scan access now (use after adding a new client account)"),
        response_format: responseFormatField
      }),
      annotations: READ_ONLY
    },
    async ({ query, include_inactive, include_managers, refresh, response_format }, ctx) => {
      const idx = await api.getAccessIndex(ctx.mcpReq.signal, refresh);
      const q = query?.trim().toLowerCase();
      const qDigits = q?.replace(/-/g, "");
      const all = [...idx.accounts.values()];
      const nameOf = (id: string | null) => (id ? idx.accounts.get(id)?.name || id : "");
      const rows = all
        .filter(a => include_inactive || a.status === "ENABLED")
        .filter(a => (include_managers ? true : !a.manager))
        .filter(a => !q || a.name.toLowerCase().includes(q) || (qDigits && a.id.includes(qDigits)))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(a => ({
          id: a.id,
          name: a.name || "(no details; not queryable)",
          type: a.manager ? "Manager (MCC)" : "Client",
          status: a.status,
          currency: a.currency,
          time_zone: a.timeZone,
          access: a.direct ? "direct" : `via ${a.viaManager} (${nameOf(a.viaManager)})`
        }));
      return renderRows(rows, response_format as ResponseFormat, { title: q ? `Accounts matching "${query}"` : "All accessible accounts" }, 500);
    }
  );
}
