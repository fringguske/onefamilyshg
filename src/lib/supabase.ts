import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "./errors";

let client: SupabaseClient | null = null;

/** Server-only database client (service role). Never import this from a client component. */
export function db(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new HttpError(500, "Set-up: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set in Vercel. Add them under Settings > Environment Variables and redeploy.");
  }
  if (!/^https:\/\/[^/]+$/.test(url.trim().replace(/\/$/, ""))) {
    throw new HttpError(500, "Set-up: SUPABASE_URL should look like https://xxxx.supabase.co (no extra path). Fix it in Vercel and redeploy.");
  }
  client = createClient(url.trim().replace(/\/$/, ""), key.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}
