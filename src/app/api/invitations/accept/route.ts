import { NextResponse } from 'next/server'
import { z } from 'zod'

import { recordAudit } from '@/lib/server/audit'
import { checkRateLimit } from '@/lib/server/rate-limit'
import { requireUser } from '@/lib/server/room-context'
import { createServerSupabase } from '@/lib/supabase/server'
import { ROLES } from '@/lib/types'
import type { ValidationIssue } from '@/lib/types'

export const dynamic = 'force-dynamic'

const AcceptSchema = z.object({
  // The schema in 0001_init.sql requires at least 32 characters; the upper bound
  // just keeps an oversized body out of the query.
  token: z.string().min(32, 'That invitation link is not valid.').max(512),
})

const AcceptResultSchema = z
  .array(z.object({ room_id: z.uuid(), role: z.enum(ROLES) }))
  .min(1)

/**
 * `public.accept_invitation` raises a distinct exception per failure so the
 * caller can say what actually went wrong. The names are matched rather than the
 * message text compared, because PostgREST wraps the raised message.
 *
 * The statuses are chosen so a client can branch on them: 401 means sign in
 * again, 403 means this account may not have it, 409 means it is spent, 400
 * means the link itself is no good.
 */
const RPC_FAILURES: { name: string; status: number; message: string }[] = [
  {
    name: 'not_authenticated',
    status: 401,
    message: 'Your session expired. Sign in again and reopen the invitation link.',
  },
  {
    name: 'invitation_email_mismatch',
    status: 403,
    message: 'This invitation was issued to a different email address. Sign in as that address to accept it.',
  },
  {
    name: 'invitation_already_accepted',
    status: 409,
    message: 'This invitation has already been used.',
  },
  {
    name: 'invitation_revoked',
    status: 403,
    message: 'This invitation was revoked by a room administrator.',
  },
  {
    name: 'invitation_expired',
    status: 400,
    message: 'This invitation has expired. Ask a room administrator for a new one.',
  },
  {
    name: 'membership_banned',
    status: 403,
    message: 'This account is banned from that room. An administrator has to lift the ban first.',
  },
  // Kept last: the others are more specific, and this is the fallback for a
  // token that simply does not exist.
  {
    name: 'invitation_invalid',
    status: 400,
    message: 'This invitation link is not valid. Ask for a fresh one.',
  },
]

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
      {
        error: issue?.message ?? 'Sign in before accepting an invitation.',
        code: 'not_authenticated',
        issues: auth.issues,
      },
      { status: auth.status ?? 401 },
    )
  }
  const user = auth.data

  const parsed = AcceptSchema.safeParse(await readJson(request))
  if (!parsed.success) return invalidBody(parsed.error)

  // A 256-bit token is not guessable, but redemption is the one authenticated
  // endpoint that accepts an arbitrary secret, so the attempt rate is capped to
  // keep it out of the "free oracle" category.
  const verdict = checkRateLimit(`invitationAcceptPerUser:${user.id}`, 20, 60 * 60 * 1000)
  if (!verdict.allowed) {
    await recordAudit({
      roomId: null,
      actorId: user.id,
      action: 'security.rate_limited',
      metadata: { bucket: 'invitationAcceptPerUser', retry_after: verdict.retryAfterSeconds },
    })
    return NextResponse.json(
      { error: 'Too many attempts. Wait a moment and try again.', code: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(verdict.retryAfterSeconds) } },
    )
  }

  // User-scoped client so `auth.uid()` inside the function is the caller. The
  // whole redemption — email match, ban check, membership upsert, `accepted_at`
  // — happens in that one transaction, which is what makes a double-click on the
  // link safe.
  const supabase = await createServerSupabase()
  const { data, error } = await supabase.rpc('accept_invitation', { p_token: parsed.data.token } as never)

  if (error) {
    const haystack = `${error.message} ${error.details ?? ''} ${error.hint ?? ''}`
    const known = RPC_FAILURES.find((failure) => haystack.includes(failure.name))

    if (known) {
      await recordAudit({
        roomId: null,
        actorId: user.id,
        action: 'security.denied',
        metadata: { reason: known.name, attempted_action: 'invitation.accept' },
      })
      // `code` is the raw exception name: the invite page maps it to its own
      // copy, and forwarding it keeps that mapping working without the page
      // having to parse prose.
      return NextResponse.json({ error: known.message, code: known.name }, { status: known.status })
    }

    console.error('[api/invitations/accept] rpc failed', {
      userId: user.id,
      code: error.code,
      message: error.message,
    })
    return NextResponse.json(
      { error: 'Could not accept that invitation right now.', code: 'invitation.accept_failed' },
      { status: 500 },
    )
  }

  // The RPC's return type collapses to `null` in postgrest-js 2.112 (the schema
  // mirror has no `Relationships` key), so the payload is validated at runtime
  // instead of asserted with a cast.
  const rows = AcceptResultSchema.safeParse(data)
  if (!rows.success) {
    console.error('[api/invitations/accept] rpc returned an unexpected shape', { userId: user.id })
    return NextResponse.json(
      { error: 'The invitation was accepted but the room could not be resolved.', code: 'invitation.no_room' },
      { status: 500 },
    )
  }
  const { room_id, role } = rows.data[0]

  await recordAudit({
    roomId: room_id,
    actorId: user.id,
    action: 'member.joined',
    targetId: user.id,
    metadata: { role, email: user.email },
  })

  return NextResponse.json({ room_id, role }, { status: 200 })
}
