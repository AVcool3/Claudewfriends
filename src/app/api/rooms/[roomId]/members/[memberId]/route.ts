import { NextResponse } from 'next/server'
import { z } from 'zod'

import { recordAudit } from '@/lib/server/audit'
import { createServerSupabase } from '@/lib/supabase/server'
import { validateSecurity } from '@/lib/validation/security-validator'
import { ASSIGNABLE_ROLES, ROLES, ROLE_LABELS } from '@/lib/types'
import type { MemberStatus, Role, RoomMember, ValidationIssue, ValidationResult } from '@/lib/types'
import type { Database } from '@/lib/database.types'

export const dynamic = 'force-dynamic'

const RoleChangeSchema = z.object({
  // Every role is parseable so `core_prompter` can be refused by name rather
  // than as an unrecognised value.
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

/**
 * Reads the target membership through the caller's own session.
 *
 * `validateSecurity` has already loaded and guarded this row, but it does not
 * hand it back, and the before/after values in the audit entry have to come from
 * somewhere. Scoped by room id as well as member id so an id from another room
 * cannot be evaluated against this room's actor.
 */
async function loadTarget(roomId: string, memberId: string): Promise<RoomMember | null> {
  const supabase = await createServerSupabase()
  const { data } = await supabase
    .from('room_members')
    .select('*')
    .eq('id', memberId)
    .eq('room_id', roomId)
    .maybeSingle<RoomMember>()
  return data
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ roomId: string; memberId: string }> },
) {
  const { roomId, memberId } = await ctx.params

  const parsed = RoleChangeSchema.safeParse(await readJson(request))
  if (!parsed.success) return invalidBody(parsed.error)

  const nextRole: Role = parsed.data.role
  if (nextRole === 'core_prompter' || !ASSIGNABLE_ROLES.includes(nextRole)) {
    return NextResponse.json(
      {
        error: `The ${ROLE_LABELS.core_prompter} role belongs to the room's owner and cannot be assigned or transferred.`,
        code: 'role.core_prompter_not_assignable',
      },
      { status: 400 },
    )
  }

  // `canChangeRole` runs inside this call because `nextRole` and
  // `targetMemberId` are both supplied — that is what stops an administrator
  // from demoting a peer or promoting anyone into the Core Prompter seat.
  const security = await validateSecurity({
    roomId,
    action: 'room.change_role',
    targetMemberId: memberId,
    nextRole,
  })
  if (!security.ok || !security.data) return failure(security)

  const before = await loadTarget(roomId, memberId)
  if (!before) {
    return NextResponse.json(
      { error: 'That member is not in this room.', code: 'member.not_found' },
      { status: 404 },
    )
  }

  if (before.role === nextRole) {
    return NextResponse.json({ member: before, changed: false }, { status: 200 })
  }

  const supabase = await createServerSupabase()
  const patch: Database['public']['Tables']['room_members']['Update'] = { role: nextRole }
  const { data: updated, error } = await supabase
    .from('room_members')
    .update(patch as never)
    .eq('id', memberId)
    .eq('room_id', roomId)
    .select('*')
    .single<RoomMember>()

  if (error || !updated) {
    // `guard_room_member` raises for the escalation cases RLS cannot express
    // (a second Core Prompter, one admin managing another).
    console.error('[api/members/:id] role update failed', { roomId, memberId, code: error?.code, message: error?.message })
    const denied = error?.code === '42501' || (error?.message ?? '').includes('core_prompter') || (error?.message ?? '').includes('admin_cannot_manage_admin')
    return NextResponse.json(
      {
        error: denied
          ? 'The database refused that role change.'
          : 'Could not change that member\'s role right now.',
        code: denied ? 'role.change_denied' : 'role.change_failed',
      },
      { status: denied ? 403 : 500 },
    )
  }

  await recordAudit({
    roomId,
    actorId: security.data.user.id,
    action: 'member.role_changed',
    targetId: memberId,
    metadata: { user_id: updated.user_id, before: before.role, after: updated.role },
  })

  // The new role takes effect on the member's next request: `current_member_role`
  // is read fresh by every RLS policy, and the row update travels to open tabs
  // over `postgres_changes`, so nothing is cached anywhere that could keep the
  // old capabilities alive.
  return NextResponse.json({ member: updated, changed: true }, { status: 200 })
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ roomId: string; memberId: string }> },
) {
  const { roomId, memberId } = await ctx.params

  const ban = new URL(request.url).searchParams.get('ban') === '1'

  // `canRemoveMember` runs inside this call for `room.remove_member` with a
  // target: the Core Prompter cannot be removed, and one administrator cannot
  // remove another.
  const security = await validateSecurity({
    roomId,
    action: 'room.remove_member',
    targetMemberId: memberId,
  })
  if (!security.ok || !security.data) return failure(security)

  const before = await loadTarget(roomId, memberId)
  if (!before) {
    return NextResponse.json(
      { error: 'That member is not in this room.', code: 'member.not_found' },
      { status: 404 },
    )
  }

  const status: MemberStatus = ban ? 'banned' : 'removed'

  // The row is updated, not deleted. A deleted membership takes the ban with it,
  // so a banned account could be re-invited and walk straight back in — and the
  // record of who removed whom would be reduced to an audit line with no row to
  // point at. `accept_invitation` reads this status and refuses a banned user.
  const supabase = await createServerSupabase()
  const patch: Database['public']['Tables']['room_members']['Update'] = { status }
  const { data: updated, error } = await supabase
    .from('room_members')
    .update(patch as never)
    .eq('id', memberId)
    .eq('room_id', roomId)
    .select('*')
    .single<RoomMember>()

  if (error || !updated) {
    console.error('[api/members/:id] removal failed', { roomId, memberId, code: error?.code, message: error?.message })
    const denied = error?.code === '42501' || (error?.message ?? '').includes('core_prompter') || (error?.message ?? '').includes('admin_cannot_manage_admin')
    return NextResponse.json(
      {
        error: denied ? 'The database refused that removal.' : 'Could not remove that member right now.',
        code: denied ? 'member.remove_denied' : 'member.remove_failed',
      },
      { status: denied ? 403 : 500 },
    )
  }

  await recordAudit({
    roomId,
    actorId: security.data.user.id,
    action: ban ? 'member.banned' : 'member.removed',
    targetId: memberId,
    metadata: { user_id: updated.user_id, previous_role: before.role, previous_status: before.status },
  })

  // Access ends immediately, in both directions:
  //   * every RLS policy resolves membership through `is_active_member` /
  //     `current_member_role`, which filter on `status = 'active'`, so the very
  //     next request from that account — including a direct PostgREST call with
  //     their own token — returns zero rows.
  //   * `room_members` is in the realtime publication with REPLICA IDENTITY
  //     FULL, so the UPDATE is pushed to the member's open tab and
  //     `useRoomRealtime` ejects them without waiting for a reload.
  return NextResponse.json({ member: updated, status }, { status: 200 })
}
