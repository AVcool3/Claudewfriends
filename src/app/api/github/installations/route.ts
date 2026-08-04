import { NextResponse } from 'next/server'

import { serverEnv } from '@/lib/env'
import { GithubError, installationUrl, listInstallationRepos } from '@/lib/github/app'
import { requireUser } from '@/lib/server/room-context'
import { createServerSupabase } from '@/lib/supabase/server'
import type { GithubInstallation } from '@/lib/types'

export const dynamic = 'force-dynamic'

/**
 * GET /api/github/installations
 *
 * The signed-in user's own GitHub App installations, each expanded with the
 * repositories it can currently reach. The repository list is fetched live
 * from GitHub rather than mirrored, so a repo removed from the installation
 * disappears here without any sync machinery.
 */
export async function GET() {
  const auth = await requireUser()
  if (!auth.ok || !auth.data) {
    return NextResponse.json(
      { error: auth.issues[0]?.message ?? 'Sign in first.', code: auth.issues[0]?.code },
      { status: auth.status ?? 401 },
    )
  }

  if (!serverEnv.githubConfigured) {
    return NextResponse.json(
      {
        configured: false,
        installations: [],
        install_url: null,
      },
      { status: 200 },
    )
  }

  const supabase = await createServerSupabase()
  // RLS scopes this to installed_by = auth.uid(); no explicit filter needed,
  // but stating it keeps the query self-documenting.
  const { data, error } = await supabase
    .from('github_installations')
    .select('*')
    .eq('installed_by', auth.data.id)
    .returns<GithubInstallation[]>()

  if (error) {
    return NextResponse.json(
      { error: 'Could not load your GitHub installations.', code: 'github.list_failed' },
      { status: 500 },
    )
  }

  const installations = await Promise.all(
    (data ?? []).map(async (installation) => {
      try {
        const repos = await listInstallationRepos(installation.installation_id)
        return {
          installation_id: installation.installation_id,
          account_login: installation.account_login,
          account_type: installation.account_type,
          suspended: installation.suspended_at !== null,
          repositories: repos.map((repo) => ({
            owner: repo.owner,
            repo: repo.repo,
            full_name: repo.fullName,
            default_branch: repo.defaultBranch,
            private: repo.private,
          })),
          error: null as string | null,
        }
      } catch (cause) {
        // One dead installation (revoked on GitHub's side, say) must not blank
        // the whole list; it is returned with its error so the UI can offer
        // the reinstall link.
        const message =
          cause instanceof GithubError ? cause.message : 'Could not reach GitHub for this installation.'
        return {
          installation_id: installation.installation_id,
          account_login: installation.account_login,
          account_type: installation.account_type,
          suspended: installation.suspended_at !== null,
          repositories: [],
          error: message,
        }
      }
    }),
  )

  return NextResponse.json(
    { configured: true, installations, install_url: installationUrl() },
    { status: 200 },
  )
}
