import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";

let client: SupabaseClient | undefined;

/** Service-role client. Server-side only: never import this into client components. */
export function db(): SupabaseClient {
  client ??= createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return client;
}
