import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "./errors";

let client: SupabaseClient | null = null;

/** Server-only database client (service role). Never import this from a client component. */
export function db(): SupabaseClient {
  if (client) return client;
  // accept the URL as copied from the dashboard, with or without /rest/v1/ on the end
  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new HttpError(500, "Set-up: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set in Vercel. Add them under Settings > Environment Variables and redeploy.");
  }
  if (!/^https:\/\/[^/]+$/.test(url)) {
    throw new HttpError(500, "Set-up: SUPABASE_URL should look like https://xxxx.supabase.co (no extra path). Fix it in Vercel and redeploy.");
  }
  client = createClient(url, key.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}
