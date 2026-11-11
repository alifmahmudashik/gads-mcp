import { db } from "@/lib/db";
import { randomToken } from "@/lib/crypto";
import { htmlPage } from "@/lib/http";
import { googleAuthUrl } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Step 1 of "Connect": Claude sends you here, we send you on to Google's account chooser.
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const clientId = q.get("client_id") ?? "";
  const redirectUri = q.get("redirect_uri") ?? "";

  const { data: client } = await db().from("oauth_clients").select("redirect_uris").eq("client_id", clientId).maybeSingle();
  // Never redirect to an unregistered address: show an error instead
  if (!client || !(client.redirect_uris as string[]).includes(redirectUri)) {
    return htmlPage("Invalid request", "Unknown client or redirect address. Remove the connector in Claude and add it again.", 400);
  }

  const fail = (error: string, description: string) => {
    const back = new URL(redirectUri);
    back.searchParams.set("error", error);
    back.searchParams.set("error_description", description);
    if (q.get("state")) back.searchParams.set("state", q.get("state")!);
    return Response.redirect(back.toString(), 302);
  };

  if (q.get("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
  const challenge = q.get("code_challenge");
  if (!challenge || q.get("code_challenge_method") !== "S256") return fail("invalid_request", "PKCE with S256 is required.");

  const id = randomToken(24);
  const { error } = await db().from("oauth_auth_requests").insert({
    id,
    client_id: clientId,
    redirect_uri: redirectUri,
    client_state: q.get("state"),
    code_challenge: challenge,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()
  });
  if (error) return fail("server_error", "Could not start sign-in.");

  return Response.redirect(googleAuthUrl(id), 302);
}
