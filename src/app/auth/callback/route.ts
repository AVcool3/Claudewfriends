import { NextResponse, type NextRequest } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'

/**
 * Only same-origin, non-protocol-relative paths are honoured. Browsers resolve
 * `//evil.example` and `/\evil.example` as absolute URLs, so a plain
 * "starts with a slash" test would leave an open redirect on the one route an
 * attacker can reliably get a victim to click.
 */
function safeNext(value: string | null): string {
  if (!value) return '/rooms'
  if (!value.startsWith('/')) return '/rooms'
  if (value.startsWith('//') || value.startsWith('/\\')) return '/rooms'
  return value
}

function loginWithError(request: NextRequest, message: string) {
  const url = new URL('/login', request.nextUrl.origin)
  url.searchParams.set('error', message)
  return NextResponse.redirect(url)
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl

  // Supabase reports a failed link (expired, already used) as query params
  // rather than an HTTP error, so this is checked before the happy path.
  const providerError = searchParams.get('error_description') ?? searchParams.get('error')
  if (providerError) return loginWithError(request, providerError)

  const code = searchParams.get('code')
  if (!code) return loginWithError(request, 'That sign-in link is incomplete. Request a new one.')

  const supabase = await createServerSupabase()
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) return loginWithError(request, error.message)

  // The session cookie was written onto the response by the client's `setAll`
  // hook, so this redirect already carries the signed-in session.
  return NextResponse.redirect(new URL(safeNext(searchParams.get('next')), origin))
}
