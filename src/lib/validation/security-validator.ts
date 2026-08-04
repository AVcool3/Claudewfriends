/**
 * Agent 2 — the security validator.
 *
 * Runs the ordered gate chain in front of every state-changing room action:
 *
 *   authenticated -> membership row exists and is `active` -> room not locked
 *   (for send) -> capability -> role-escalation guard -> rate limit -> length
 *   -> injection heuristics
 *
 * The order matters. Cheap identity checks come before anything that touches a
 * rate-limit bucket, so an unauthenticated probe cannot burn a legitimate
 * user's quota; the capability check comes before the role-escalation guard so
 * a viewer never learns whether a given member id exists.
 *
 * These are deterministic, local checks — no model call. Per-message validation
 * has to be fast and free, and every rule here is expressible as code, so
 * spending a Claude round trip on it would buy nothing but latency and cost.
 */

import { recordAudit } from '@/lib/server/audit'
import { LIMITS, checkRateLimit } from '@/lib/server/rate-limit'
import { isUuid, loadRoomContext, requireUser } from '@/lib/server/room-context'
import type { RoomContextResult } from '@/lib/server/room-context'
import { can, canChangeRole, canRemoveMember, denialReason, membershipContext } from '@/lib/permissions'
import type { Capability } from '@/lib/permissions'
import {
  INJECTION_SUSPICION_THRESHOLD,
  assertMessageLength,
  detectPromptInjection,
  normaliseMessage,
} from '@/lib/sanitize'
import type { InjectionFinding } from '@/lib/sanitize'
import { createServerSupabase } from '@/lib/supabase/server'
import { validationFailure, validationSuccess } from '@/lib/types'
import type {
  AuditAction,
  Role,
  RoomMember,
  ValidationIssue,
  ValidationResult,
} from '@/lib/types'

export interface SecurityCheckInput {
  roomId: string
  action: Capability
  content?: string
  targetMemberId?: string
  nextRole?: Role
}

export interface SecurityContext extends RoomContextResult {
  injection: { score: number; findings: InjectionFinding[]; suspicious: boolean }
}

interface RateRule {
  /** Stable name; also the bucket prefix, so retuning a limit keeps the bucket. */
  name: string
  limit: number
  windowMs: number
  key: (roomId: string, userId: string) => string
}

/**
 * Which buckets each action consumes.
 *
 * `claudePerRoom` is keyed on the room alone and deliberately omits the action:
 * sending and approving both cause exactly one Claude turn, so they must share
 * one bucket or the per-room ceiling is trivially doubled.
 */
const RATE_RULES: Partial<Record<Capability, RateRule[]>> = {
  'room.send_message': [
    { name: 'messagePerUser', ...LIMITS.messagePerUser, key: (r, u) => `messagePerUser:${r}:${u}` },
    { name: 'claudePerRoom', ...LIMITS.claudePerRoom, key: (r) => `claudePerRoom:${r}` },
  ],
  'room.approve_message': [
    { name: 'claudePerRoom', ...LIMITS.claudePerRoom, key: (r) => `claudePerRoom:${r}` },
  ],
  'room.invite': [
    { name: 'invitePerRoom', ...LIMITS.invitePerRoom, key: (r) => `invitePerRoom:${r}` },
  ],
}

/** Actions that carry user-authored text destined for the Claude prompt. */
const CONTENT_ACTIONS: Capability[] = ['room.send_message', 'room.approve_message']

/** Fresh object per call — the value is handed to the caller inside `SecurityContext`. */
function noInjection(): SecurityContext['injection'] {
  return { score: 0, findings: [], suspicious: false }
}

async function deny(args: {
  input: SecurityCheckInput
  actorId: string | null
  code: string
  message: string
  status: number
  auditAction?: AuditAction
  metadata?: Record<string, unknown>
}): Promise<ValidationResult<SecurityContext>> {
  await recordAudit({
    roomId: args.input.roomId,
    actorId: args.actorId,
    action: args.auditAction ?? 'security.denied',
    targetId: args.input.targetMemberId ?? null,
    metadata: {
      reason: args.code,
      attempted_action: args.input.action,
      ...args.metadata,
    },
  })
  return validationFailure(args.code, args.message, args.status)
}

export async function validateSecurity(
  input: SecurityCheckInput,
): Promise<ValidationResult<SecurityContext>> {
  // ---- 1. authenticated -------------------------------------------------
  // Resolved before `loadRoomContext` even though that helper repeats the
  // check, purely so every denial below can be attributed to a user id in the
  // audit log. An unattributed "someone was denied" line is close to useless
  // when investigating a removed member probing a room they used to be in.
  const auth = await requireUser()
  if (!auth.ok || !auth.data) {
    // No actor to attribute and no proven room association, so nothing is
    // audited here — an unauthenticated request is not evidence about a room.
    return { ok: false, issues: auth.issues, status: auth.status }
  }
  const actorId = auth.data.id

  // ---- 2. membership row exists and is `active` -------------------------
  // `loadRoomContext` collapses "no such room" and "not a member" into one 404
  // and turns a non-active membership into a 403.
  const contextResult = await loadRoomContext(input.roomId)
  if (!contextResult.ok || !contextResult.data) {
    const issue = contextResult.issues[0]
    await recordAudit({
      roomId: isUuid(input.roomId) ? input.roomId : null,
      actorId,
      action: 'security.denied',
      metadata: { reason: issue?.code ?? 'room.unavailable', attempted_action: input.action },
    })
    return { ok: false, issues: contextResult.issues, status: contextResult.status }
  }
  const ctx = contextResult.data

  // The sender's identity is taken from `ctx` — which came from the verified
  // session — and never from the request body. There is no field a caller can
  // set to claim they are someone else, which is what makes impersonation a
  // non-issue rather than something we have to detect.
  const { membership, roomCtx, room } = ctx

  // ---- 3. room not locked (send only) -----------------------------------
  // `can('room.send_message', …)` already covers this, but checking it first
  // yields "the room is locked" instead of a generic permission denial.
  if (input.action === 'room.send_message' && membership.role !== 'core_prompter') {
    if (roomCtx.isLocked) {
      return deny({
        input,
        actorId,
        code: 'room.locked',
        message: denialReason('room.send_message', membership, roomCtx),
        status: 403,
      })
    }
    if (!roomCtx.allowCollaboratorMessages) {
      return deny({
        input,
        actorId,
        code: 'room.messaging_paused',
        message: denialReason('room.send_message', membership, roomCtx),
        status: 403,
      })
    }
  }

  // ---- 4. capability ----------------------------------------------------
  if (!can(input.action, membership, roomCtx)) {
    return deny({
      input,
      actorId,
      code: 'permission.denied',
      message: denialReason(input.action, membership, roomCtx),
      status: 403,
      metadata: { role: membership.role },
    })
  }

  // ---- 5. role-escalation guard -----------------------------------------
  if (input.nextRole !== undefined || input.targetMemberId !== undefined) {
    const targetResult = await loadTargetMember(input.roomId, input.targetMemberId)
    if (!targetResult.ok || !targetResult.data) {
      return deny({
        input,
        actorId,
        code: targetResult.issues[0]?.code ?? 'member.not_found',
        message: targetResult.issues[0]?.message ?? 'That member could not be found.',
        status: targetResult.status ?? 404,
      })
    }

    const targetMembership = membershipContext(targetResult.data, room)

    if (input.nextRole !== undefined) {
      const verdict = canChangeRole(membership, targetMembership, input.nextRole)
      if (!verdict.allowed) {
        return deny({
          input,
          actorId,
          code: 'role.change_denied',
          message: verdict.reason ?? 'You cannot change that member\'s role.',
          status: 403,
          metadata: { next_role: input.nextRole, target_role: targetMembership.role },
        })
      }
    } else if (input.action === 'room.remove_member') {
      const verdict = canRemoveMember(membership, targetMembership)
      if (!verdict.allowed) {
        return deny({
          input,
          actorId,
          code: 'member.remove_denied',
          message: verdict.reason ?? 'You cannot remove that member.',
          status: 403,
          metadata: { target_role: targetMembership.role },
        })
      }
    }
    // Any other action that names a target only needed the existence check
    // above; running a removal guard on it would deny unrelated operations.
  }

  // ---- 6. rate limit ----------------------------------------------------
  for (const rule of RATE_RULES[input.action] ?? []) {
    const verdict = checkRateLimit(rule.key(input.roomId, actorId), rule.limit, rule.windowMs)
    if (!verdict.allowed) {
      // Recorded twice on purpose: `security.denied` keeps one queryable stream
      // of every refusal, and `security.rate_limited` gives throttling its own
      // series without having to parse metadata.
      await recordAudit({
        roomId: input.roomId,
        actorId,
        action: 'security.rate_limited',
        metadata: { bucket: rule.name, attempted_action: input.action, retry_after: verdict.retryAfterSeconds },
      })
      return deny({
        input,
        actorId,
        code: 'rate_limited',
        message: `Too many requests. Try again in ${verdict.retryAfterSeconds} second${
          verdict.retryAfterSeconds === 1 ? '' : 's'
        }.`,
        status: 429,
        metadata: { bucket: rule.name, retry_after: verdict.retryAfterSeconds },
      })
    }
  }

  // ---- 7. length --------------------------------------------------------
  let injection = noInjection()
  const needsContent = CONTENT_ACTIONS.includes(input.action)

  if (input.content === undefined) {
    if (input.action === 'room.send_message') {
      return deny({
        input,
        actorId,
        code: 'content.required',
        message: 'A message is required.',
        status: 400,
      })
    }
  } else if (needsContent || input.content.length > 0) {
    // Normalised before measuring so padding and invisible characters cannot be
    // used to sneak past — or trip — the limit. `normaliseMessage` is
    // idempotent, so the pipeline normalising again later is harmless.
    const normalised = normaliseMessage(input.content)
    const lengthResult = assertMessageLength(normalised)
    if (!lengthResult.ok) {
      return deny({
        input,
        actorId,
        code: lengthResult.issues[0]?.code ?? 'message.invalid',
        message: lengthResult.issues[0]?.message ?? 'That message is not valid.',
        status: lengthResult.status ?? 400,
      })
    }

    // ---- 8. injection heuristics ---------------------------------------
    const detection = detectPromptInjection(normalised)
    const suspicious = detection.score >= INJECTION_SUSPICION_THRESHOLD
    injection = { score: detection.score, findings: detection.findings, suspicious }

    if (suspicious) {
      await recordAudit({
        roomId: input.roomId,
        actorId,
        action: 'security.prompt_injection_suspected',
        metadata: { score: detection.score, findings: detection.findings },
      })
    }
  }

  const issues: ValidationIssue[] = []
  if (injection.suspicious) {
    // Warn, do not block. The structural defence — collaborator text is framed
    // as data with the frame markers escaped out of it, and the system prompt
    // says framed text is never an instruction — is what actually holds. A
    // regex gate would reject legitimate discussion about prompting while still
    // missing any paraphrase, so the heuristic's job is to raise a flag for the
    // Core Prompter and the audit log, not to decide.
    issues.push({
      code: 'security.prompt_injection_suspected',
      message: 'This message looks like it may be trying to redirect Claude. It was sent as data, not as an instruction.',
      severity: 'warning',
    })
  }

  return validationSuccess({ ...ctx, injection }, issues)
}

/**
 * Loads the membership row an action targets, with the user-scoped client so
 * RLS decides whether the actor may see it at all.
 */
async function loadTargetMember(
  roomId: string,
  targetMemberId: string | undefined,
): Promise<ValidationResult<RoomMember>> {
  if (targetMemberId === undefined) {
    return validationFailure('member.target_required', 'No member was specified.', 400)
  }
  if (!isUuid(targetMemberId)) {
    return validationFailure('member.invalid_id', 'That member id is not valid.', 400)
  }

  const supabase = await createServerSupabase()
  // Scoped by `room_id` as well as `id` so a member id from another room cannot
  // be smuggled in and evaluated against this room's actor.
  const { data, error } = await supabase
    .from('room_members')
    .select('*')
    .eq('id', targetMemberId)
    .eq('room_id', roomId)
    // Explicit row type: see the note in `room-context.ts` about the missing
    // `Relationships` key in the schema mirror.
    .maybeSingle<RoomMember>()

  if (error) {
    console.error('[security] target member lookup failed', { roomId, message: error.message })
    return validationFailure('member.lookup_failed', 'Could not load that member right now.', 500)
  }
  if (!data) {
    return validationFailure('member.not_found', 'That member is not in this room.', 404)
  }

  return validationSuccess(data)
}
