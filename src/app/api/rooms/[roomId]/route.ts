import { NextResponse } from 'next/server'
import { z } from 'zod'

import { recordAudit } from '@/lib/server/audit'
import { loadRoomContext } from '@/lib/server/room-context'
import { createServerSupabase } from '@/lib/supabase/server'
import { validateSecurity } from '@/lib/validation/security-validator'
import { COLLABORATION_MODES, MAX_ROOM_NAME_LENGTH } from '@/lib/types'
import type { AuditAction, Room, ValidationIssue, ValidationResult } from '@/lib/types'
import type { Capability } from '@/lib/permissions'
import type { Database } from '@/lib/database.types'

export const dynamic = 'force-dynamic'

const PatchRoomSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'A room needs a name.')
    .max(MAX_ROOM_NAME_LENGTH, `Room names are limited to ${MAX_ROOM_NAME_LENGTH} characters.`)
    .optional(),
  collaboration_mode: z.enum(COLLABORATION_MODES).optional(),
  is_locked: z.boolean().optional(),
  allow_collaborator_messages: z.boolean().optional(),
})

type PatchBody = z.infer<typeof PatchRoomSchema>
type PatchField = keyof PatchBody

/**
 * Which capability each field needs.
 *
 * Renaming is gated on `room.change_mode` rather than a capability of its own:
 * `can()` resolves that to the Core Prompter alone, which is exactly the rule
 * `guard_room_update` enforces in Postgres for the name column. Locking is the
 * one setting an administrator may also touch.
 */
const FIELD_CAPABILITY: Record<PatchField, Capability> = {
  name: 'room.change_mode',
  collaboration_mode: 'room.change_mode',
  is_locked: 'room.lock',
  allow_collaborator_messages: 'room.toggle_messaging',
}

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

/** Renders any failed `ValidationResult` as the shared `{ error, code, issues }` body. */
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

export async function PATCH(request: Request, ctx: { params: Promise<{ roomId: string }> }) {
  // Next 15 hands route params as a Promise; awaiting is mandatory.
  const { roomId } = await ctx.params

  const parsed = PatchRoomSchema.safeParse(await readJson(request))
  if (!parsed.success) return invalidBody(parsed.error)

  const context = await loadRoomContext(roomId)
  if (!context.ok || !context.data) return failure(context)
  const room = context.data.room

  // Only fields whose value actually changes are gated and audited. A PATCH that
  // re-sends the current value is a no-op, not a permission question — otherwise
  // an administrator's settings form, which posts every field, would be refused
  // for the ones they cannot change even when they changed none of them.
  const changes = (Object.keys(parsed.data) as PatchField[]).filter((field) => {
    const next = parsed.data[field]
    return next !== undefined && next !== room[field]
  })

  if (changes.length === 0) {
    return NextResponse.json({ room, changed: [] }, { status: 200 })
  }

  // Checked per field rather than once for the whole request: the fields carry
  // different capabilities, and a single check would let a request that mixes an
  // allowed change with a forbidden one through on the strength of the allowed
  // one.
  for (const field of changes) {
    const security = await validateSecurity({ roomId, action: FIELD_CAPABILITY[field] })
    if (!security.ok) return failure(security)
  }

  const patch: Database['public']['Tables']['rooms']['Update'] = {}
  for (const field of changes) {
    if (field === 'name') patch.name = parsed.data.name
    if (field === 'collaboration_mode') patch.collaboration_mode = parsed.data.collaboration_mode
    if (field === 'is_locked') patch.is_locked = parsed.data.is_locked
    if (field === 'allow_collaborator_messages') {
      patch.allow_collaborator_messages = parsed.data.allow_collaborator_messages
    }
  }

  const supabase = await createServerSupabase()
  const { data: updated, error } = await supabase
    .from('rooms')
    .update(patch as never)
    .eq('id', roomId)
    .select('*')
    .single<Room>()

  if (error || !updated) {
    // `guard_room_update` raises for a non-owner touching anything but the lock,
    // and for the immutable columns. Those arrive as a plpgsql exception rather
    // than an RLS refusal, so they are reported as a permission failure.
    console.error('[api/rooms/:id] update failed', { roomId, code: error?.code, message: error?.message })
    const denied = error?.code === '42501' || (error?.message ?? '').includes('room_')
    return NextResponse.json(
      {
        error: denied
          ? 'The database refused that change. Only the Core Prompter can rename a room or change its collaboration settings.'
          : 'Could not update that room right now.',
        code: denied ? 'room.update_denied' : 'room.update_failed',
      },
      { status: denied ? 403 : 500 },
    )
  }

  // One audit row per field, each carrying its own before/after. A single
  // combined row would make "who unlocked this room" unanswerable without
  // parsing a diff.
  for (const field of changes) {
    let action: AuditAction = 'room.mode_changed'
    if (field === 'is_locked') action = updated.is_locked ? 'room.locked' : 'room.unlocked'
    else if (field === 'allow_collaborator_messages') action = 'room.messaging_toggled'

    await recordAudit({
      roomId,
      actorId: context.data.user.id,
      action,
      targetId: roomId,
      // `field` is carried explicitly because the audit action list has no
      // rename entry, so a name change reuses `room.mode_changed` and this is
      // what tells the two apart.
      metadata: { field, before: room[field], after: updated[field] },
    })
  }

  return NextResponse.json({ room: updated, changed: changes }, { status: 200 })
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await ctx.params

  const security = await validateSecurity({ roomId, action: 'room.delete' })
  if (!security.ok || !security.data) return failure(security)
  const { room, user } = security.data

  // Written before the delete: `audit_logs.room_id` is ON DELETE SET NULL, and
  // the room's name and settings are gone the moment the row is. Auditing
  // afterwards would leave a record that something was deleted with no way to
  // tell what.
  await recordAudit({
    roomId,
    actorId: user.id,
    action: 'room.deleted',
    targetId: roomId,
    metadata: {
      name: room.name,
      collaboration_mode: room.collaboration_mode,
      created_at: room.created_at,
    },
  })

  const supabase = await createServerSupabase()
  const { error } = await supabase.from('rooms').delete().eq('id', roomId)

  if (error) {
    console.error('[api/rooms/:id] delete failed', { roomId, code: error.code, message: error.message })
    return NextResponse.json(
      { error: 'Could not delete that room right now.', code: 'room.delete_failed' },
      { status: error.code === '42501' ? 403 : 500 },
    )
  }

  // Members, messages, invitations and the Claude session are removed by the
  // ON DELETE CASCADE chain, so there is nothing else to clean up here.
  return NextResponse.json({ deleted: true, room_id: roomId }, { status: 200 })
}
