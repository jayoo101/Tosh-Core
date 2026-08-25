import { createClient } from '@supabase/supabase-js'

// ─────────────────────────────────────────────────────────────────────────────
// Supabase client — shared singleton for both server and client usage.
//
// Required env vars (add to soat-frontend/.env.local):
//   NEXT_PUBLIC_SUPABASE_URL      — Project URL from Supabase dashboard
//   NEXT_PUBLIC_SUPABASE_ANON_KEY — Public anon key (safe to expose)
//
// Supabase table DDL (run once in the SQL editor):
// ─────────────────────────────────────────────────────────────────────────────
// CREATE TABLE projects (
//   id            UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
//   tx_hash       TEXT        NOT NULL UNIQUE,
//   token_address TEXT,
//   hook_address  TEXT,
//   name          TEXT        NOT NULL,
//   symbol        TEXT        NOT NULL,
//   logo_url      TEXT,
//   website       TEXT,
//   twitter       TEXT,
//   telegram      TEXT,
//   description   TEXT,
//   created_at    TIMESTAMPTZ DEFAULT NOW()
// );
// ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
// CREATE POLICY "public read"  ON projects FOR SELECT USING (true);
// CREATE POLICY "service write" ON projects FOR INSERT WITH CHECK (true);
// ─────────────────────────────────────────────────────────────────────────────

const supabaseUrl  = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

if (!supabaseUrl || !supabaseAnon) {
  throw new Error(
    'Missing Supabase env vars. Add NEXT_PUBLIC_SUPABASE_URL and ' +
    'NEXT_PUBLIC_SUPABASE_ANON_KEY to soat-frontend/.env.local'
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnon)

// ── Row shape (mirrors DB schema) ─────────────────────────────────────────────
export interface ProjectRow {
  id:            string
  tx_hash:       string
  token_address: string | null
  hook_address:  string | null
  name:          string
  symbol:        string
  logo_url:      string | null
  website:       string | null
  twitter:       string | null
  telegram:      string | null
  description:   string | null
  created_at:    string
}
