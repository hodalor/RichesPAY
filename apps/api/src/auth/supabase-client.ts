import { createClient } from "@supabase/supabase-js";

import type { AppEnv } from "../env";

export function createSupabaseAnonClient(env: AppEnv) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}
