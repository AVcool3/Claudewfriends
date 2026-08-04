import { NextResponse, type NextRequest } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'

/**
 * POST-only: a GET sign-out can be triggered by any image tag or prefetch on a
 * third-party page, which is a trivial denial-of-service on the user's session.
 */
export async function POST(request: NextRequest) {
  const supabase = await createServerSupabase()
  await supabase.auth.signOut()

  // 303 forces the browser to follow up with a GET; a 307 would replay the POST
  // against /login.
  return NextResponse.redirect(new URL('/login', request.nextUrl.origin), { status: 303 })
}
