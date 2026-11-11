import { db } from "./db";
import { randomToken, sha256 } from "./crypto";
import { appUrl, env } from "./env";

export const GOOGLE_SCOPES = "https://www.googleapis.com/auth/adwords openid email";
export const ACCESS_TTL_SECONDS = 60 * 60; // 1 hour
export const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days, rotated on every use

export const googleRedirectUri = (): string => `${appUrl()}/api/oauth/google/callback`;

export function googleAuthUrl(state: string): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.search = new URLSearchParams({
    client_id: env("GOOGLE_OAUTH_CLIENT_ID"),
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: GOOGLE_SCOPES,
    access_type: "offline",
    // consent => Google returns a refresh token every time; select_account => shows the account chooser
    prompt: "consent select_account",
    state
  }).toString();
  return u.toString();
}

export async function exchangeGoogleCode(code: string): Promise<{ refresh_token?: string; id_token?: string; error?: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env("GOOGLE_OAUTH_CLIENT_ID"),
      client_secret: env("GOOGLE_OAUTH_CLIENT_SECRET"),
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code"
    })
  });
  const data = (await res.json().catch(() => ({}))) as { refresh_token?: string; id_token?: string; error_description?: string };
  if (!res.ok) return { error: data.error_description ?? `Google returned HTTP ${res.status}` };
  return data;
}

/** The id_token comes straight from Google's token endpoint over TLS, so reading its payload is safe. */
export function identityFromIdToken(idToken?: string): { email?: string; emailVerified: boolean } {
  try {
    const payload = JSON.parse(Buffer.from(idToken!.split(".")[1]!, "base64url").toString("utf8")) as { email?: string; email_verified?: boolean };
    return { email: payload.email?.toLowerCase(), emailVerified: payload.email_verified === true };
  } catch {
    return { emailVerified: false };
  }
}

/**
 * ALLOWED_EMAILS: comma-separated list, or "*" / empty / unset to allow any verified Google account.
 * Each user only ever reaches the Google Ads accounts their own Google login can access.
 */
export function isEmailAllowed(email: string): boolean {
  const list = (process.env.ALLOWED_EMAILS ?? "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
  if (list.length === 0 || list.includes("*")) return true;
  return list.includes(email.toLowerCase());
}

const iso = (secondsFromNow: number) => new Date(Date.now() + secondsFromNow * 1000).toISOString();

/** Creates an access + refresh token pair for Claude. Only SHA-256 hashes are stored. */
export async function issueTokens(clientId: string, userId: string) {
  const access = randomToken();
  const refresh = randomToken();
  const { error } = await db().from("oauth_tokens").insert([
    { token_hash: sha256(access), kind: "access", client_id: clientId, user_id: userId, expires_at: iso(ACCESS_TTL_SECONDS) },
    { token_hash: sha256(refresh), kind: "refresh", client_id: clientId, user_id: userId, expires_at: iso(REFRESH_TTL_SECONDS) }
  ]);
  if (error) throw new Error(`Could not store tokens: ${error.message}`);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_SECONDS, refresh_token: refresh, scope: "ads" };
}

export interface AuthContext {
  userId: string;
  clientId: string;
  expiresAt: number; // epoch seconds
}

/** Validates the Bearer access token on an MCP request. */
export async function authenticate(req: Request): Promise<AuthContext | null> {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return null;
  const { data } = await db()
    .from("oauth_tokens")
    .select("user_id, client_id, expires_at, revoked")
    .eq("token_hash", sha256(m[1]!))
    .eq("kind", "access")
    .maybeSingle();
  if (!data || data.revoked || new Date(data.expires_at).getTime() <= Date.now()) return null;
  return { userId: data.user_id as string, clientId: data.client_id as string, expiresAt: Math.floor(new Date(data.expires_at).getTime() / 1000) };
}
