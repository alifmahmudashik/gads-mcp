import { db } from "@/lib/db";
import { pkceS256, safeEqual, sha256 } from "@/lib/crypto";
import { json, preflight } from "@/lib/http";
import { issueTokens } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const err = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);

// Step 3: Claude exchanges its one-time code (or a refresh token) for MCP access tokens.
export async function POST(req: Request) {
  const type = req.headers.get("content-type") ?? "";
  const body: Record<string, string> = type.includes("json")
    ? ((await req.json().catch(() => ({}))) as Record<string, string>)
    : Object.fromEntries(new URLSearchParams(await req.text()));

  const grant = body.grant_type;
  const clientId = body.client_id ?? "";

  if (grant === "authorization_code") {
    const { code, redirect_uri, code_verifier } = body;
    if (!code || !code_verifier) return err("invalid_request", "code and code_verifier are required.");

    // Atomically mark the code as used so it can't be replayed
    const { data: row } = await db().from("oauth_codes").update({ used: true }).eq("code_hash", sha256(code)).eq("used", false).select("*").maybeSingle();
    if (!row || new Date(row.expires_at).getTime() < Date.now()) return err("invalid_grant", "Code is invalid, used or expired.");
    if (row.client_id !== clientId || row.redirect_uri !== redirect_uri) return err("invalid_grant", "Client or redirect URI mismatch.");
    if (!safeEqual(pkceS256(code_verifier), row.code_challenge as string)) return err("invalid_grant", "PKCE verification failed.");

    return json(await issueTokens(clientId, row.user_id as string));
  }

  if (grant === "refresh_token") {
    const refresh = body.refresh_token;
    if (!refresh) return err("invalid_request", "refresh_token is required.");
    const { data: row } = await db().from("oauth_tokens").update({ revoked: true }).eq("token_hash", sha256(refresh)).eq("kind", "refresh").eq("revoked", false).select("*").maybeSingle();
    if (!row || new Date(row.expires_at).getTime() < Date.now() || row.client_id !== clientId) return err("invalid_grant", "Refresh token is invalid or expired.");
    return json(await issueTokens(clientId, row.user_id as string)); // rotates: old refresh token is now revoked
  }

  return err("unsupported_grant_type", "Use authorization_code or refresh_token.");
}
export const OPTIONS = preflight;
