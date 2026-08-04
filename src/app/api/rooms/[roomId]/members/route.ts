import { randomBytes } from 'node:crypto'

import { NextResponse } from 'next/server'
import { z } from 'zod'

import { requirePublicEnv } from '@/lib/env'
import { recordAudit } from '@/lib/server/audit'
import { loadRoomContext } from '@/lib/server/room-context'
import { createAdminClient } from '@/lib/supabase/admin'
import { createServerSupabase } from '@/lib/supabase/server'
import { validateSecurity } from '@/lib/validation/security-validator'
import { ASSIGNABLE_ROLES, ROLES, ROLE_LABELS } from '@/lib/types'
import type {
  Invitation,
  InvitationSummary,
  Profile,
  Role,
  RoomMember,
  RoomMemberWithProfile,
  ValidationIssue,
  ValidationResult,
} from '@/lib/types'
import type { Database } from '@/lib/database.types'

export const dynamic = 'force-dynamic'

/** A member counts as online if their presence heartbeat landed within this window. */
const PRESENCE_WINDOW_MS = 60_000

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Every column of `invitations` except `token`.
 *
 * Named explicitly rather than selected with `*` and stripped afterwards: the
 * token is a bearer secret for the room, and a projection that never leaves
 * Postgres cannot be leaked by a later refactor that forgets to delete a key.
 */
const INVITATION_COLUMNS = 'id, room_id, email, role, expires_at, accepted_at, revoked_at, invited_by, created_at'

const InviteSchema = z.object({
  email: z.email('Enter a valid email address.').max(320),
  // Parsed against every role, not just the assignable ones, so a request for
  // `core_prompter` can be refused with a reason instead of a generic
  // "invalid enum value".
  role: z.enum(ROLES),
})

function issuesFromZod(error: z.ZodError): ValidationIssue[] {
  const flat = z.flattenError(error)
  const issues: ValidationIssue[] = flat.formErrors.map((message) => ({
    code: 'validation.body',
    message,
    severity: 'critical',
  }))
  // Annotated rather than inferred: `flattenError`'s mapped `fieldErrors` type
  // widens to `{}` under `Object.entries`, which is not iterable.
  const fieldErrors: Record<string, string[] | undefined> = flat.fieldErrors
  for (const [field, messages] of Object.entries(fieldErrors)) {
    for (const message of messages ?? []) {
      issues.push({ code: `validation.${field}`, message, severity: 'critical' })
    }
  }
  return issues
}

function invalidBody(error: z.ZodError): NextResponse {
  const issues = issuesFromZod(error)
  return NextResponse.json(
    { error: issues[0]?.message ?? 'That request is not valid.', code: 'validation.failed', issues },
    { status: 400 },
  )
}

function failure(result: ValidationResult<unknown>): NextResponse {
  const issue = result.issues[0]
  return NextResponse.json(
    { error: issue?.message ?? 'That request could not be completed.', code: issue?.code, issues: result.issues },
    { status: result.status ?? 400 },
  )
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}

export async function GET(_request: Request, ctx: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await ctx.params

  // Any active member may see the roster — that is `room.view`, which
  // `loadRoomContext` already proves by returning at all.
  const context = await loadRoomContext(roomId)
  if (!context.ok || !context.data) return failure(context)

  const supabase = await createServerSupabase()

  const [membersResponse, invitationsResponse] = await Promise.all([
    supabase
      .from('room_members')
      .select('*')
      .eq('room_id', roomId)
      .order('created_at', { ascending: true })
      .returns<RoomMember[]>(),
    supabase
      .from('invitations')
      .select(INVITATION_COLUMNS)
      .eq('room_id', roomId)
      .is('accepted_at', null)
      .is('revoked_at', null)
      // Expiry is filtered in Postgres so a stale link never appears as pending.
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .returns<InvitationSummary[]>(),
  ])

  if (membersResponse.error) {
    console.error('[api/members] roster read failed', { roomId, message: membersResponse.error.message })
    return NextResponse.json(
      { error: 'Could not load this room\'s members.', code: 'members.load_failed' },
      { status: 500 },
    )
  }

  // `invitations_select_admin` returns zero rows to a collaborator or viewer, so
  // no extra branch is needed here: non-admins simply get an empty list.
  if (invitationsResponse.error) {
    console.error('[api/members] invitation read failed', { roomId, message: invitationsResponse.error.message })
  }

  const members = membersResponse.data ?? []

  // `room_members` references `auth.users`, not `profiles`, so PostgREST has no
  // relationship to embed and the join is done here.
  const userIds = [...new Set(members.map((member) => member.user_id))]
  const profilesResponse =
    userIds.length > 0
      ? await supabase.from('profiles').select('*').in('id', userIds).returns<Profile[]>()
      : { data: [] as Profile[], error: null }

  if (profilesResponse.error) {
    console.error('[api/members] profile read failed', { roomId, message: profilesResponse.error.message })
  }

  const profileById = new Map<string, Profile>()
  for (const profile of profilesResponse.data ?? []) profileById.set(profile.id, profile)

  const now = Date.now()
  const withProfiles: RoomMemberWithProfile[] = members.map((member) => {
    const lastSeen = member.last_seen_at ? Date.parse(member.last_seen_at) : Number.NaN
    return {
      ...member,
      profile: profileById.get(member.user_id) ?? null,
      // Derived rather than stored: an "is_online" column would need a writer to
      // clear it, and a crashed tab never writes anything.
      is_online:
        member.status === 'active' && Number.isFinite(lastSeen) && now - lastSeen <= PRESENCE_WINDOW_MS,
    }
  })

  return NextResponse.json(
    { members: withProfiles, invitations: invitationsResponse.data ?? [] },
    { status: 200 },
  )
}

export async function POST(request: Request, ctx: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await ctx.params

  const parsed = InviteSchema.safeParse(await readJson(request))
  if (!parsed.success) return invalidBody(parsed.error)

  const role: Role = parsed.data.role
  if (role === 'core_prompter') {
    return NextResponse.json(
      {
        error: `The ${ROLE_LABELS.core_prompter} role belongs to the room's owner and cannot be invited or transferred. Invite an ${ROLE_LABELS.administrator} instead.`,
        code: 'invite.core_prompter_not_assignable',
      },
      { status: 400 },
    )
  }
  if (!ASSIGNABLE_ROLES.includes(role)) {
    return NextResponse.json(
      { error: 'That role cannot be assigned through an invitation.', code: 'invite.role_not_assignable' },
      { status: 400 },
    )
  }

  // Capability, role-escalation guard and the `invitePerRoom` bucket all run
  // inside this call — `RATE_RULES['room.invite']` consumes the bucket, so the
  // limit must not be checked again here or every invite would cost two slots.
  const security = await validateSecurity({ roomId, action: 'room.invite' })
  if (!security.ok || !security.data) return failure(security)
  const { room, user } = security.data

  // The database normalises this too (`trg_invitations_normalise_email`); doing
  // it here as well means the duplicate lookups below compare the same value the
  // constraint will store.
  const email = parsed.data.email.trim().toLowerCase()

  const admin = createAdminClient()
  const supabase = await createServerSupabase()

  // Service-role lookup: the address may belong to somebody the caller has never
  // shared a room with, so `profiles_select` would hide them and we would invite
  // an existing member all over again. Only a boolean is derived from this read —
  // nothing about the account is returned to the caller.
  const { data: invitee } = await admin
    .from('profiles')
    .select('*')
    .eq('email', email)
    .maybeSingle<Profile>()

  if (invitee) {
    const { data: existingMember } = await admin
      .from('room_members')
      .select('*')
      .eq('room_id', roomId)
      .eq('user_id', invitee.id)
      .maybeSingle<RoomMember>()

    if (existingMember?.status === 'active') {
      return NextResponse.json(
        {
          error: `${invitee.display_name} is already a member of this room.`,
          code: 'invite.already_member',
        },
        { status: 409 },
      )
    }
    if (existingMember?.status === 'banned') {
      // `accept_invitation` refuses a banned account anyway; saying so now stops
      // an administrator from sending a link that can never work.
      return NextResponse.json(
        {
          error: `${invitee.display_name} is banned from this room. Lift the ban before inviting them again.`,
          code: 'invite.banned',
        },
        { status: 409 },
      )
    }
  }

  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS).toISOString()
  const { siteUrl } = requirePublicEnv()

  // An outstanding invitation is refreshed rather than duplicated: a second row
  // would leave two live tokens for one address, and revoking the visible one
  // would not close the other.
  const { data: existingInvitation } = await supabase
    .from('invitations')
    .select('*')
    .eq('room_id', roomId)
    .eq('email', email)
    .is('accepted_at', null)
    .is('revoked_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<Invitation>()

  if (existingInvitation) {
    const patch: Database['public']['Tables']['invitations']['Update'] = {
      expires_at: expiresAt,
      role,
    }
    const { data: refreshed, error } = await supabase
      .from('invitations')
      .update(patch as never)
      .eq('id', existingInvitation.id)
      .select(INVITATION_COLUMNS)
      .single<InvitationSummary>()

    if (error || !refreshed) {
      console.error('[api/members] invitation refresh failed', { roomId, message: error?.message })
      return NextResponse.json(
        { error: 'Could not refresh that invitation.', code: 'invite.refresh_failed' },
        { status: 500 },
      )
    }

    const inviteUrl = `${siteUrl}/invite/${existingInvitation.token}`
    await recordAudit({
      roomId,
      actorId: user.id,
      action: 'member.invited',
      targetId: refreshed.id,
      // The token is deliberately absent; `recordAudit` would redact it anyway.
      metadata: { email, role, refreshed: true, expires_at: expiresAt },
    })

    return NextResponse.json(
      { invitation: { ...refreshed, invite_url: inviteUrl }, invite_url: inviteUrl, refreshed: true },
      { status: 200 },
    )
  }

  // 32 bytes from the CSPRNG. base64url keeps it URL-safe without escaping, and
  // 256 bits is far past anything an attacker can enumerate against a table with
  // a unique index on the column.
  const token = randomBytes(32).toString('base64url')

  const payload: Database['public']['Tables']['invitations']['Insert'] = {
    room_id: roomId,
    email,
    role,
    token,
    expires_at: expiresAt,
    // `invitations_insert_admin` requires `invited_by = auth.uid()`, so this is
    // checked by Postgres and not merely asserted here.
    invited_by: user.id,
  }

  const { data: created, error } = await supabase
    .from('invitations')
    .insert(payload as never)
    .select(INVITATION_COLUMNS)
    .single<InvitationSummary>()

  if (error || !created) {
    console.error('[api/members] invitation insert failed', { roomId, code: error?.code, message: error?.message })
    return NextResponse.json(
      { error: 'Could not create that invitation.', code: 'invite.create_failed' },
      { status: error?.code === '42501' ? 403 : 500 },
    )
  }

  await recordAudit({
    roomId,
    actorId: user.id,
    action: 'member.invited',
    targetId: created.id,
    metadata: { email, role, room_name: room.name, expires_at: expiresAt },
  })

  // The URL is returned exactly once, to the administrator who just created it.
  // `GET` above never includes it, so the token does not fan out to the access
  // panel of every other admin.
  const inviteUrl = `${siteUrl}/invite/${token}`
  return NextResponse.json(
    { invitation: { ...created, invite_url: inviteUrl }, invite_url: inviteUrl, refreshed: false },
    { status: 201 },
  )
}
