import { db } from "@/lib/db";
import { encrypt, randomToken, sha256 } from "@/lib/crypto";
import { htmlPage } from "@/lib/http";
import { isEmailAllowed, exchangeGoogleCode, identityFromIdToken } from "@/lib/oauth";
import { detectLoginCustomer } from "@/lib/ads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Step 2: Google sends you back here. We save your Google login, then hand Claude a one-time code.
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  if (q.get("error")) return htmlPage("Sign-in cancelled", `Google said: ${q.get("error")}. Go back to Claude and click Connect again.`, 400);

  const state = q.get("state") ?? "";
  const code = q.get("code");
  const { data: request } = await db().from("oauth_auth_requests").select("*").eq("id", state).maybeSingle();
  if (!code || !request || new Date(request.expires_at).getTime() < Date.now()) {
    return htmlPage("Sign-in expired", "This sign-in link is invalid or expired. Go back to Claude and click Connect again.", 400);
  }
  await db().from("oauth_auth_requests").delete().eq("id", state); // single use

  const tokens = await exchangeGoogleCode(code);
  if (tokens.error || !tokens.refresh_token) {
    return htmlPage("Sign-in failed", tokens.error ?? "Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.", 400);
  }

  const { email, emailVerified } = identityFromIdToken(tokens.id_token);
  if (!email || !emailVerified || !isEmailAllowed(email)) {
    return htmlPage("Not allowed", "This Google account is not on the allowed list for this server.", 403);
  }

  const { data: user, error } = await db()
    .from("users")
    .upsert({ email, google_refresh_token_enc: encrypt(tokens.refresh_token), updated_at: new Date().toISOString() }, { onConflict: "email" })
    .select("id")
    .single();
  if (error || !user) return htmlPage("Server error", "Could not save your Google login.", 500);

  await detectLoginCustomer(user.id as string); // best effort: finds your manager (MCC) account

  // Hand Claude a one-time code (only its hash is stored)
  const authCode = randomToken();
  const { error: codeError } = await db().from("oauth_codes").insert({
    code_hash: sha256(authCode),
    client_id: request.client_id,
    redirect_uri: request.redirect_uri,
    code_challenge: request.code_challenge,
    user_id: user.id,
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString()
  });
  if (codeError) return htmlPage("Server error", "Could not complete sign-in.", 500);

  const back = new URL(request.redirect_uri as string);
  back.searchParams.set("code", authCode);
  if (request.client_state) back.searchParams.set("state", request.client_state as string);
  return Response.redirect(back.toString(), 302);
}
