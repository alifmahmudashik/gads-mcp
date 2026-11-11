import { appUrl } from "@/lib/env";
import { json, preflight } from "@/lib/http";

export const dynamic = "force-dynamic";

// RFC 8414: where Claude registers, sends you to sign in, and exchanges codes for tokens
export async function GET() {
  const base = appUrl();
  return json({
    issuer: base,
    authorization_endpoint: `${base}/api/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["ads"]
  });
}
export const OPTIONS = preflight;
