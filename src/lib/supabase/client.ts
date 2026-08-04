'use client'

import { createBrowserClient } from '@supabase/ssr'
import type { Database } from '@/lib/database.types'
import { requirePublicEnv } from '@/lib/env'

let cached: ReturnType<typeof createBrowserClient<Database>> | null = null

/**
 * Browser Supabase client. Carries the anon key only — every read it performs
 * is filtered by Row Level Security, so a tampered room id simply returns no
 * rows rather than another room's data.
 */
export function createClient() {
  if (cached) return cached
  const { supabaseUrl, supabaseAnonKey } = requirePublicEnv()
  cached = createBrowserClient<Database>(supabaseUrl, supabaseAnonKey)
  return cached
}
