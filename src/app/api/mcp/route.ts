import { createMcpHandler } from "@modelcontextprotocol/server";
import { appUrl } from "@/lib/env";
import { CORS, preflight } from "@/lib/http";
import { authenticate } from "@/lib/oauth";
import { createServer } from "@/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Stateless: the factory runs once per request, with the verified user from our bearer check
const handler = createMcpHandler(({ authInfo }) => createServer(String(authInfo?.extra?.userId)));

async function handle(req: Request): Promise<Response> {
  const auth = await authenticate(req);
  if (!auth) {
    // 401 + resource_metadata is what makes Claude show the "Connect" button
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "WWW-Authenticate": `Bearer resource_metadata="${appUrl()}/.well-known/oauth-protected-resource"`,
        ...CORS
      }
    });
  }
  const res = await handler.fetch(req, {
    authInfo: { token: "", clientId: auth.clientId, scopes: ["ads"], expiresAt: auth.expiresAt, extra: { userId: auth.userId } }
  });
  return res;
}

export { handle as GET, handle as POST, handle as DELETE };
export const OPTIONS = preflight;
