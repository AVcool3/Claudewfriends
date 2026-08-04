import { NextResponse } from 'next/server'
import { z } from 'zod'

import type { Database } from '@/lib/database.types'
import { serverEnv } from '@/lib/env'
import { GithubError, installationUrl } from '@/lib/github/app'
import { getRepoMeta } from '@/lib/github/repo'
import { recordAudit } from '@/lib/server/audit'
import { loadRoomContext } from '@/lib/server/room-context'
import { createServerSupabase } from '@/lib/supabase/server'
import type { RepoActionRecord, RepoConnection } from '@/lib/types'
import { REPO_ACCESS_MODES } from '@/lib/types'

export const dynamic = 'force-dynamic'

const ConnectSchema = z.object({
  installation_id: z.number().int().positive(),
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  access_mode: z.enum(REPO_ACCESS_MODES).optional(),
})

const PatchSchema = z.object({
  access_mode: z.enum(REPO_ACCESS_MODES),
})

function failure(issues: { code: string; message: string }[], status: number) {
  return NextResponse.json(
    { error: issues[0]?.message ?? 'Request failed.', code: issues[0]?.code, issues },
    { status },
  )
}

/**
 * GET — the room's connection plus recent repository activity. Any active
 * member may look: they are talking to a Claude that can read this repo.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await ctx.params
  const context = await loadRoomContext(roomId)
  if (!context.ok || !context.data) return failure(context.issues, context.status ?? 403)

  const supabase = await createServerSupabase()
  const [connectionResult, actionsResult] = await Promise.all([
    supabase.from('repo_connections').select('*').eq('room_id', roomId).maybeSingle<RepoConnection>(),
    supabase
      .from('repo_actions')
      .select('*')
      .eq('room_id', roomId)
      .order('created_at', { ascending: false })
      .limit(30)
      .returns<RepoActionRecord[]>(),
  ])

  if (connectionResult.error) {
    return failure([{ code: 'repo.load_failed', message: 'Could not load the repository connection.' }], 500)
  }

  return NextResponse.json(
    {
      configured: serverEnv.githubConfigured,
      connection: connectionResult.data,
      actions: actionsResult.data ?? [],
      can_connect: context.data.capabilities['room.connect_repo'],
      install_url: serverEnv.githubConfigured ? installationUrl() : null,
    },
    { status: 200 },
  )
}

/**
 * POST — connect (or repoint) the room's repository. Core Prompter only; the
 * database trigger additionally requires the installation to belong to them.
 */
export async function POST(request: Request, ctx: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await ctx.params
  const context = await loadRoomContext(roomId)
  if (!context.ok || !context.data) return failure(context.issues, context.status ?? 403)

  if (!context.data.capabilities['room.connect_repo']) {
    await recordAudit({
      roomId,
      actorId: context.data.user.id,
      action: 'security.denied',
      metadata: { capability: 'room.connect_repo' },
    })
    return failure(
      [{ code: 'repo.forbidden', message: 'Only the Core Prompter can connect a repository.' }],
      403,
    )
  }

  if (!serverEnv.githubConfigured) {
    return failure(
      [{ code: 'github.not_configured', message: 'GitHub is not configured for this deployment.' }],
      501,
    )
  }

  const parsed = ConnectSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return failure(
      parsed.error.issues.map((issue) => ({ code: 'repo.invalid', message: issue.message })),
      400,
    )
  }
  const body = parsed.data

  /*
   * Reaching the repository through the installation is the proof that the
   * pairing is real: the token minted here is scoped to that installation, so
   * a repo it cannot see fails now, at connect time, with a message the owner
   * can act on — not later, mid-conversation.
   */
  let meta
  try {
    meta = await getRepoMeta({
      installationId: body.installation_id,
      owner: body.owner,
      repo: body.repo,
    })
  } catch (error) {
    const message =
      error instanceof GithubError
        ? error.message
        : 'Could not verify that repository through GitHub.'
    const status = error instanceof GithubError ? error.status : 502
    return failure([{ code: 'repo.unreachable', message }], status)
  }

  const supabase = await createServerSupabase()
  const payload: Database['public']['Tables']['repo_connections']['Insert'] = {
    room_id: roomId,
    installation_id: body.installation_id,
    owner: body.owner,
    repo: body.repo,
    default_branch: meta.defaultBranch,
    access_mode: body.access_mode ?? 'read',
    connected_by: context.data.user.id,
  }

  // Upsert on room_id: connecting over an existing binding repoints it, which
  // is the owner changing their mind, not an error. RLS plus the ownership
  // trigger both re-check on this write.
  const { data, error } = await supabase
    .from('repo_connections')
    .upsert(payload as never, { onConflict: 'room_id' })
    .select('*')
    .single<RepoConnection>()

  if (error) {
    const notOwned = error.message.includes('installation_not_owned')
    return failure(
      [
        notOwned
          ? {
              code: 'repo.installation_not_owned',
              message: 'That GitHub installation was set up by a different account. Install the app from your own GitHub account first.',
            }
          : { code: 'repo.connect_failed', message: 'Could not save the repository connection.' },
      ],
      notOwned ? 403 : 500,
    )
  }

  await recordAudit({
    roomId,
    actorId: context.data.user.id,
    action: 'repo.connected',
    metadata: {
      owner: body.owner,
      repo: body.repo,
      access_mode: data.access_mode,
      installation_id: body.installation_id,
    },
  })

  return NextResponse.json({ connection: data }, { status: 201 })
}

/** PATCH — flip the access mode between read-only and read+PR. */
export async function PATCH(request: Request, ctx: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await ctx.params
  const context = await loadRoomContext(roomId)
  if (!context.ok || !context.data) return failure(context.issues, context.status ?? 403)

  if (!context.data.capabilities['room.connect_repo']) {
    return failure(
      [{ code: 'repo.forbidden', message: 'Only the Core Prompter can change repository access.' }],
      403,
    )
  }

  const parsed = PatchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return failure([{ code: 'repo.invalid', message: 'access_mode must be read or read_pr.' }], 400)
  }

  const supabase = await createServerSupabase()
  const { data, error } = await supabase
    .from('repo_connections')
    .update({ access_mode: parsed.data.access_mode } as never)
    .eq('room_id', roomId)
    .select('*')
    .single<RepoConnection>()

  if (error || !data) {
    return failure(
      [{ code: 'repo.not_connected', message: 'This room has no repository connected.' }],
      404,
    )
  }

  await recordAudit({
    roomId,
    actorId: context.data.user.id,
    action: 'repo.access_mode_changed',
    metadata: { access_mode: parsed.data.access_mode },
  })

  return NextResponse.json({ connection: data }, { status: 200 })
}

/** DELETE — detach the repository from the room. */
export async function DELETE(_request: Request, ctx: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await ctx.params
  const context = await loadRoomContext(roomId)
  if (!context.ok || !context.data) return failure(context.issues, context.status ?? 403)

  if (!context.data.capabilities['room.connect_repo']) {
    return failure(
      [{ code: 'repo.forbidden', message: 'Only the Core Prompter can disconnect the repository.' }],
      403,
    )
  }

  const supabase = await createServerSupabase()
  const { data, error } = await supabase
    .from('repo_connections')
    .delete()
    .eq('room_id', roomId)
    .select('owner, repo')
    .maybeSingle<{ owner: string; repo: string }>()

  if (error) {
    return failure([{ code: 'repo.disconnect_failed', message: 'Could not disconnect the repository.' }], 500)
  }

  if (data) {
    await recordAudit({
      roomId,
      actorId: context.data.user.id,
      action: 'repo.disconnected',
      metadata: { owner: data.owner, repo: data.repo },
    })
  }

  return NextResponse.json({ disconnected: data !== null }, { status: 200 })
}
