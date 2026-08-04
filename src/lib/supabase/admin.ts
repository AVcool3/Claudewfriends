import 'server-only'

import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import { requirePublicEnv } from '@/lib/env'
import { serverEnv } from '@/lib/env'

let cached: ReturnType<typeof createClient<Database>> | null = null

/**
 * Service-role client. Bypasses Row Level Security, so it is used only for
 * operations that RLS deliberately cannot express:
 *
 *   - writing `audit_logs` (append-only, unreadable by members)
 *   - reading an invitation by token before the caller is a member
 *   - writing Claude's assistant turns on behalf of the room
 *
 * The `server-only` import above makes bundling this into a client component a
 * build error.
 */
export function createAdminClient() {
  if (cached) return cached
  const { supabaseUrl } = requirePublicEnv()
  cached = createClient<Database>(supabaseUrl, serverEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return cached
}
