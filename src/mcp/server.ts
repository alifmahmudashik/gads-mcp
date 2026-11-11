import { McpServer } from "@modelcontextprotocol/server";
import { makeAds } from "@/lib/ads";
import { registerGenericTools } from "./tools/generic";
import { registerReadTools } from "./tools/read";
import { registerWriteTools } from "./tools/write";

/** A fresh server per request, bound to the signed-in user. Shared state lives in module scope / Supabase. */
export function createServer(userId: string): McpServer {
  const api = makeAds(userId);
  const server = new McpServer({ name: "google-ads-mcp-server", version: "1.0.0" });
  registerReadTools(server, api);
  registerWriteTools(server, api);
  registerGenericTools(server, api);
  return server;
}
