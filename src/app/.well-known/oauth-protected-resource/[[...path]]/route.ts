import { appUrl } from "@/lib/env";
import { json, preflight } from "@/lib/http";

export const dynamic = "force-dynamic";

// RFC 9728: tells Claude which authorization server protects the MCP endpoint
export async function GET() {
  return json({
    resource: `${appUrl()}/mcp`,
    authorization_servers: [appUrl()],
    bearer_methods_supported: ["header"],
    scopes_supported: ["ads"],
    resource_name: "Google Ads MCP"
  });
}
export const OPTIONS = preflight;
