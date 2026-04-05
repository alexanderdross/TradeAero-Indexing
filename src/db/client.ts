import { createClient } from "@supabase/supabase-js";
import { config } from "../config.js";

/**
 * Supabase client using the SERVICE ROLE key.
 * Bypasses RLS — must only be used in this backend indexing service.
 */
export const supabase = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  {
    auth: { persistSession: false },
  },
);
