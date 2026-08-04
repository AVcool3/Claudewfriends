import { NextResponse, type NextRequest } from 'next/server'

import { fetchInstallation, GithubError } from '@/lib/github/app'
import { recordAudit } from '@/lib/server/audit'
import { getSessionUser } from '@/lib/supabase/server'
import { createServerSupabase } from '@/lib/supabase/server'
import type { Database } from '@/lib/database.types'

export const dynamic = 'force-dynamic'

/**
 * GET /github/setup — the GitHub App's post-install redirect ("Setup URL").
 *
 * GitHub sends the browser here with `installation_id` after the user installs
 * or reconfigures the app. The id is claimed for the *signed-in user*, and the
 * claim is only honoured after asking GitHub (authenticated as the app) that
 * the installation actually exists.
 *
 * That verification step is what stops the one attack this endpoint invites: a
 * crafted link with someone else's installation_id. Registering it would only
 * work if GitHub confirms the id — and even then the row records the claimer,
 * who gains nothing beyond the ability to *use* an installation GitHub says
 * exists. The pairing of installation -> repositories is GitHub's own state,
 * so the worst a forged claim can do is register an id the victim's account
 * already controls, which grants access to precisely nothing until GitHub
 * mints a token for it — and it only will for our app's genuine installs.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser()
  const url = request.nextUrl

  if (!user) {
    // Round-trip through login, then land back here with the same params so
    // the claim completes.
    const login = url.clone()
    login.pathname = '/login'
    login.search = ''
    login.searchParams.set('next', `${url.pathname}${url.search}`)
    return NextResponse.redirect(login)
  }

  const rawId = url.searchParams.get('installation_id')
  const installationId = Number.parseInt(rawId ?? '', 10)

  if (!Number.isFinite(installationId) || installationId <= 0) {
    return NextResponse.redirect(destination(url, 'github=invalid'))
  }

  let summary
  try {
    summary = await fetchInstallation(installationId)
  } catch (error) {
    const failed =
      error instanceof GithubError && error.code === 'not_found' ? 'github=unknown' : 'github=error'
    return NextResponse.redirect(destination(url, failed))
  }

  const supabase = await createServerSupabase()
  const payload: Database['public']['Tables']['github_installations']['Insert'] = {
    installation_id: summary.installationId,
    account_login: summary.accountLogin,
    account_type: summary.accountType,
    installed_by: user.id,
    suspended_at: summary.suspended ? new Date().toISOString() : null,
  }

  // Upsert on the unique installation_id: GitHub re-sends the setup redirect on
  // "configure" as well as install, and re-claiming your own installation is a
  // refresh, not an error. RLS restricts the write to installed_by = auth.uid(),
  // so a re-claim of a row owned by someone else fails closed.
  const { error } = await supabase
    .from('github_installations')
    .upsert(payload as never, { onConflict: 'installation_id' })

  if (error) {
    const already = error.code === '42501'
    return NextResponse.redirect(destination(url, already ? 'github=claimed' : 'github=error'))
  }

  await recordAudit({
    roomId: null,
    actorId: user.id,
    action: 'repo.connected',
    metadata: {
      installation_id: summary.installationId,
      account: summary.accountLogin,
      stage: 'installation_registered',
    },
  })

  return NextResponse.redirect(destination(url, 'github=connected'))
}

/** Back to the app, preserving an optional room to return to via `state`. */
function destination(url: URL, flag: string): URL {
  // GitHub echoes the `state` query param we put on the install link. It names
  // the room whose settings launched the install, and is validated as a UUID
  // path segment rather than trusted as a URL — open-redirect hygiene.
  const state = url.searchParams.get('state')
  const roomId = state && /^[0-9a-f-]{36}$/i.test(state) ? state : null

  // Built from origin + a fixed internal path, never from user-controlled URL
  // fields, so there is no way to redirect off-origin here.
  const target = new URL(roomId ? `/rooms/${roomId}` : '/rooms', url.origin)
  target.search = `?${flag}`
  return target
}
