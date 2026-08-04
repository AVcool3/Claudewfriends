import { NextResponse } from 'next/server'
import { z } from 'zod'

import { recordAudit } from '@/lib/server/audit'
import { LIMITS, checkRateLimit } from '@/lib/server/rate-limit'
import { requireUser } from '@/lib/server/room-context'
import { createAdminClient } from '@/lib/supabase/admin'
import { createServerSupabase } from '@/lib/supabase/server'
import { COLLABORATION_MODES, MAX_ROOM_NAME_LENGTH } from '@/lib/types'
import type { ClaudeSession, Room, RoomMember, ValidationIssue } from '@/lib/types'
import type { Database } from '@/lib/database.types'

// Every route here reads the session cookie and writes to Postgres, so caching a
// response would serve one user's room to another.
export const dynamic = 'force-dynamic'

const CreateRoomSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'A room needs a name.')
    .max(MAX_ROOM_NAME_LENGTH, `Room names are limited to ${MAX_ROOM_NAME_LENGTH} characters.`),
  collaboration_mode: z.enum(COLLABORATION_MODES).optional(),
})

/**
 * Flattens a zod failure into the `ValidationIssue[]` the rest of the API uses,
 * so a client has one error shape to handle whether the rejection came from the
 * schema or from a capability check.
 */
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

async function readJson(request: Request): Promise<unknown> {
  // A malformed body is a client bug; returning `null` lets the schema produce
  // the error message instead of the route throwing a 500.
  try {
    return await request.json()
  } catch {
    return null
  }
}

export async function POST(request: Request) {
  const auth = await requireUser()
  if (!auth.ok || !auth.data) {
    const issue = auth.issues[0]
    return NextResponse.json(
      { error: issue?.message ?? 'You must be signed in.', code: issue?.code, issues: auth.issues },
      { status: auth.status ?? 401 },
    )
  }
  const user = auth.data

  const parsed = CreateRoomSchema.safeParse(await readJson(request))
  if (!parsed.success) return invalidBody(parsed.error)

  // There is no room yet, so `validateSecurity` has nothing to load and the
  // bucket is checked directly. Keyed per user: room creation is not a per-room
  // action, and an unbounded loop here would mint rows in three tables each time.
  const verdict = checkRateLimit(
    `roomCreatePerUser:${user.id}`,
    LIMITS.roomCreatePerUser.limit,
    LIMITS.roomCreatePerUser.windowMs,
  )
  if (!verdict.allowed) {
    await recordAudit({
      roomId: null,
      actorId: user.id,
      action: 'security.rate_limited',
      metadata: { bucket: 'roomCreatePerUser', retry_after: verdict.retryAfterSeconds },
    })
    return NextResponse.json(
      {
        error: `Too many rooms created. Try again in ${verdict.retryAfterSeconds} seconds.`,
        code: 'rate_limited',
      },
      { status: 429, headers: { 'Retry-After': String(verdict.retryAfterSeconds) } },
    )
  }

  const supabase = await createServerSupabase()

  const payload: Database['public']['Tables']['rooms']['Insert'] = {
    name: parsed.data.name,
    // `rooms_insert_own` requires `owner_id = auth.uid()`, so a forged owner in
    // the body would be rejected by Postgres rather than silently honoured.
    owner_id: user.id,
    collaboration_mode: parsed.data.collaboration_mode,
  }

  // `insert(… as never)`: postgrest-js 2.112 needs a `Relationships` key on each
  // table in the schema mirror and `database.types.ts` has none, so the builder
  // argument degrades to `never`. The payload above is still fully checked.
  const { data: room, error } = await supabase
    .from('rooms')
    .insert(payload as never)
    .select('*')
    .single<Room>()

  if (error || !room) {
    console.error('[api/rooms] insert failed', { userId: user.id, message: error?.message })
    return NextResponse.json(
      { error: 'Could not create that room right now.', code: 'room.create_failed' },
      { status: error?.code === '42501' ? 403 : 500 },
    )
  }

  // `trg_rooms_bootstrap` creates the owner's membership and the Claude session
  // inside the same transaction as the insert. Verified rather than assumed,
  // because a project that skipped the migration would otherwise hand back a
  // room that looks fine and then fails on the first message with an opaque
  // permission error. Read with the service-role client: we want ground truth
  // about whether the trigger fired, not a visibility answer.
  const admin = createAdminClient()
  const [memberCheck, sessionCheck] = await Promise.all([
    admin
      .from('room_members')
      .select('*')
      .eq('room_id', room.id)
      .eq('user_id', user.id)
      .maybeSingle<RoomMember>(),
    admin.from('claude_sessions').select('*').eq('room_id', room.id).maybeSingle<ClaudeSession>(),
  ])

  if (!memberCheck.data || !sessionCheck.data) {
    console.error('[api/rooms] bootstrap trigger did not run', {
      roomId: room.id,
      hasMembership: Boolean(memberCheck.data),
      hasSession: Boolean(sessionCheck.data),
    })

    // Rolled back so the caller is not left with a room that can never be used.
    // The console line and the audit row below preserve the diagnosis.
    await supabase.from('rooms').delete().eq('id', room.id)
    await recordAudit({
      roomId: null,
      actorId: user.id,
      action: 'room.deleted',
      targetId: room.id,
      metadata: {
        reason: 'bootstrap_incomplete',
        has_membership: Boolean(memberCheck.data),
        has_session: Boolean(sessionCheck.data),
      },
    })

    return NextResponse.json(
      {
        error:
          'The room could not be provisioned. Apply supabase/migrations/0001_init.sql — the trg_rooms_bootstrap trigger that creates the owner membership and the Claude session is missing.',
        code: 'room.bootstrap_missing',
      },
      { status: 500 },
    )
  }

  await recordAudit({
    roomId: room.id,
    actorId: user.id,
    action: 'room.created',
    targetId: room.id,
    metadata: { name: room.name, collaboration_mode: room.collaboration_mode },
  })

  return NextResponse.json({ room, member: memberCheck.data }, { status: 201 })
}
