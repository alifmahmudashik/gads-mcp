import { db } from "@/lib/db";
import { randomToken } from "@/lib/crypto";
import { json, preflight } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// RFC 7591 dynamic client registration: Claude calls this once when you add the connector.
// Registering grants nothing: signing in still requires an allowed Google account.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { client_name?: string; redirect_uris?: unknown } | null;
  const uris = body?.redirect_uris;
  const valid =
    Array.isArray(uris) &&
    uris.length > 0 &&
    uris.length <= 10 &&
    uris.every(u => {
      try {
        const x = new URL(String(u));
        return x.protocol === "https:" || (x.protocol === "http:" && ["localhost", "127.0.0.1"].includes(x.hostname));
      } catch {
        return false;
      }
    });
  if (!valid) return json({ error: "invalid_redirect_uri", error_description: "redirect_uris must be 1-10 https URLs (or http://localhost)." }, 400);

  const clientId = randomToken(16);
  const clientName = String(body?.client_name ?? "MCP client").slice(0, 100);
  const { error } = await db().from("oauth_clients").insert({ client_id: clientId, client_name: clientName, redirect_uris: uris });
  if (error) return json({ error: "server_error", error_description: "Could not register client." }, 500);

  return json(
    {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_id_issued_at: Math.floor(Date.now() / 1000)
    },
    201
  );
}
export const OPTIONS = preflight;
