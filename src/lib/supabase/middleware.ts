import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import type { Database } from '@/lib/database.types'
import { publicEnv } from '@/lib/env'

const PUBLIC_PATHS = ['/login', '/auth', '/invite', '/_next', '/favicon.ico']

function isPublicPath(pathname: string) {
  return PUBLIC_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/**
 * API routes still get their session cookie refreshed, but must never be
 * redirected.
 *
 * `fetch` follows redirects transparently, so a 307 to /login turns an expired
 * session into a 200 carrying an HTML login page. `response.ok` is then true
 * and the caller parses markup as JSON — surfacing as "the server did not
 * return an id" rather than "you are signed out". Letting the request through
 * lets the route's own `requireUser` / `loadRoomContext` answer 401 in the
 * shape the client already knows how to read.
 */
function isApiPath(pathname: string) {
  return pathname === '/api' || pathname.startsWith('/api/')
}

/**
 * Refreshes the Supabase auth cookie on every request and bounces
 * unauthenticated visitors to /login. This is a convenience redirect, not the
 * security boundary — Row Level Security still governs every row.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request })

  if (!publicEnv.supabaseUrl || !publicEnv.supabaseAnonKey) {
    // Unconfigured deployment: let the page render its own setup error.
    return response
  }

  const supabase = createServerClient<Database>(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value)
        }
        response = NextResponse.next({ request })
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options)
        }
      },
    },
  })

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname, search } = request.nextUrl

  if (!user && !isApiPath(pathname) && !isPublicPath(pathname)) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.search = ''
    if (pathname !== '/') {
      url.searchParams.set('next', `${pathname}${search}`)
    }
    return NextResponse.redirect(url)
  }

  if (user && pathname === '/login') {
    const url = request.nextUrl.clone()
    url.pathname = '/rooms'
    url.search = ''
    return NextResponse.redirect(url)
  }

  return response
}
