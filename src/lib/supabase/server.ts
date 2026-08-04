import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import type { Database } from '@/lib/database.types'
import { requirePublicEnv } from '@/lib/env'

/**
 * Request-scoped Supabase client that carries the signed-in user's session.
 * Reads and writes through this client are still subject to Row Level
 * Security — it is the anon key plus the user's JWT, never the service role.
 */
export async function createServerSupabase() {
  const cookieStore = await cookies()
  const { supabaseUrl, supabaseAnonKey } = requirePublicEnv()

  return createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options)
          }
        } catch {
          // `set` throws when called from a Server Component. The middleware
          // refreshes the session cookie, so this is safe to ignore.
        }
      },
    },
  })
}

/** Returns the authenticated user, or null. Always verifies against Supabase. */
export async function getSessionUser() {
  const supabase = await createServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user
}
