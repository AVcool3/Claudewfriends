import 'server-only'

/**
 * The nine-step message pipeline.
 *
 * Every route that puts words in front of Claude comes through here, and the
 * steps run in a fixed order because each one depends on the guarantee the
 * previous one established:
 *
 *   1. identify the authenticated sender          (never from the request body)
 *   2. confirm permission to post                 (validateSecurity)
 *   3. store the original message                 (user-scoped write, RLS runs)
 *   4. label sender identity and role
 *   5. convert to a structured contribution       (buildStructuredContribution)
 *   6. add conversation context                   (buildClaudeRequest)
 *   7. send to Claude under the Core Prompter's session
 *   8. save Claude's response                     (service-role write)
 *   9. broadcast + session bookkeeping
 *
 * Two independent validator subsystems gate step 7. `validateSecurity` (step 2)
 * answers "is this person allowed to do this", `verifyClaudeRequest` answers
 * "is the thing we are about to send well formed". A turn only goes out when
 * both have approved; a failure in either one never reaches the Anthropic API.
 */

import { ClaudeError, runClaudeTurn } from '@/lib/claude/client'
import type { ClaudeTurnResult } from '@/lib/claude/client'
import {
  buildClaudeRequest,
  buildStructuredContribution,
  buildSystemPrompt,
} from '@/lib/claude/prompt'
import type { ClaudeRequestShape } from '@/lib/claude/prompt'
import { requiresApproval } from '@/lib/permissions'
import { recordAudit } from '@/lib/server/audit'
import { normaliseMessage } from '@/lib/sanitize'
import { createAdminClient } from '@/lib/supabase/admin'
import { createServerSupabase } from '@/lib/supabase/server'
import {
  isTransientFailure,
  verifyAssistantPersisted,
  verifyClaudeRequest,
  verifyClaudeResponse,
  verifyMessageStored,
  withRetry,
} from '@/lib/validation/functionality-validator'
import { validateSecurity } from '@/lib/validation/security-validator'
import type { SecurityContext } from '@/lib/validation/security-validator'
import { CLAUDE_HISTORY_LIMIT, validationFailure, validationSuccess } from '@/lib/types'
import type {
  ApprovalStatus,
  ClaudeConversationState,
  ClaudeSession,
  Message,
  MessageWithSender,
  Profile,
  Role,
  RoomMember,
  SenderType,
  ValidationIssue,
  ValidationResult,
} from '@/lib/types'
import type { Database } from '@/lib/database.types'

export interface SubmitResult {
  message: Message
  queued: boolean
  assistantMessage: Message | null
  warnings: ValidationIssue[]
}

/** Statuses whose rows actually reached Claude and therefore belong in a replay. */
const DELIVERED_STATUSES: ApprovalStatus[] = ['approved', 'sent']

const DEFAULT_CONVERSATION_STATE: ClaudeConversationState = {
  turn_count: 0,
  last_message_id: null,
  total_input_tokens: 0,
  total_output_tokens: 0,
  last_error: null,
}

// ---------------------------------------------------------------------------
// Transcript assembly
// ---------------------------------------------------------------------------

interface TranscriptContext {
  history: MessageWithSender[]
  participants: { name: string; role: Role }[]
  corePrompterName: string
  profileById: Map<string, Profile>
  roleByUserId: Map<string, Role>
}

/**
 * Loads everything needed to rebuild the conversation for Claude.
 *
 * Read with the service-role client on purpose. Whether the caller may act on
 * this room was settled by `validateSecurity` before we got here, so running
 * these reads through RLS again would not add a check — it would only make a
 * missing row ambiguous between "it does not exist" and "you cannot see it",
 * which is exactly the distinction the pipeline needs to keep sharp. The
 * message and member tables also have no foreign key to `profiles` (both point
 * at `auth.users`), so PostgREST cannot embed the author and the join is done
 * here instead.
 */
async function loadTranscriptContext(args: {
  roomId: string
  ownerId: string
  excludeIds: string[]
}): Promise<TranscriptContext> {
  const admin = createAdminClient()
  const exclude = new Set(args.excludeIds)

  const [messagesResponse, membersResponse] = await Promise.all([
    admin
      .from('messages')
      .select('*')
      .eq('room_id', args.roomId)
      // Pending and rejected rows never reached Claude. Filtering in Postgres
      // rather than after the fact means the `limit` below counts only turns
      // that will actually be replayed.
      .in('approval_status', DELIVERED_STATUSES)
      .order('created_at', { ascending: false })
      .limit(CLAUDE_HISTORY_LIMIT + exclude.size)
      .returns<Message[]>(),
    admin
      .from('room_members')
      .select('*')
      .eq('room_id', args.roomId)
      .eq('status', 'active')
      .returns<RoomMember[]>(),
  ])

  if (messagesResponse.error) {
    console.error('[pipeline] history read failed', {
      roomId: args.roomId,
      message: messagesResponse.error.message,
    })
  }
  if (membersResponse.error) {
    console.error('[pipeline] roster read failed', {
      roomId: args.roomId,
      message: membersResponse.error.message,
    })
  }

  const rows = (messagesResponse.data ?? []).filter((row) => !exclude.has(row.id))
  const members = membersResponse.data ?? []

  const userIds = new Set<string>([args.ownerId])
  for (const row of rows) if (row.sender_id) userIds.add(row.sender_id)
  for (const member of members) userIds.add(member.user_id)

  const profilesResponse = await admin
    .from('profiles')
    .select('*')
    .in('id', [...userIds])
    .returns<Profile[]>()

  if (profilesResponse.error) {
    console.error('[pipeline] profile read failed', {
      roomId: args.roomId,
      message: profilesResponse.error.message,
    })
  }

  const profileById = new Map<string, Profile>()
  for (const profile of profilesResponse.data ?? []) profileById.set(profile.id, profile)

  const roleByUserId = new Map<string, Role>()
  for (const member of members) roleByUserId.set(member.user_id, member.role)

  const history: MessageWithSender[] = rows.map((row) => ({
    ...row,
    sender: row.sender_id ? (profileById.get(row.sender_id) ?? null) : null,
    sender_role: row.sender_id ? (roleByUserId.get(row.sender_id) ?? null) : null,
  }))

  return {
    history,
    participants: members.map((member) => ({
      name: profileById.get(member.user_id)?.display_name ?? 'Unnamed participant',
      role: member.role,
    })),
    corePrompterName: profileById.get(args.ownerId)?.display_name ?? 'The Core Prompter',
    profileById,
    roleByUserId,
  }
}

/**
 * Builds the structured contribution for a stored row authored by somebody other
 * than the caller — the approve and combine paths, where the Core Prompter is
 * acting on a collaborator's message.
 */
function contributionForRow(args: {
  row: Message
  body: string
  transcript: TranscriptContext
  roomName: string
  approvedByName: string | null
}): string {
  const profile = args.row.sender_id ? (args.transcript.profileById.get(args.row.sender_id) ?? null) : null
  const liveRole = args.row.sender_id ? args.transcript.roleByUserId.get(args.row.sender_id) : undefined

  return buildStructuredContribution({
    corePrompterName: args.transcript.corePrompterName,
    senderName: profile?.display_name ?? 'Former participant',
    // A membership that has since been removed leaves no live role. Falling back
    // to the row's own `sender_type` keeps the label truthful without ever
    // guessing upwards into the Core Prompter's voice.
    senderRole: liveRole ?? (args.row.sender_type === 'core_prompter' ? 'core_prompter' : 'collaborator'),
    senderEmail: profile?.email ?? 'unknown',
    content: args.body,
    roomName: args.roomName,
    approvedBy: args.approvedByName,
    edited: args.row.edited_content !== null,
  })
}

/**
 * Appends the turn being sent now to the replayed history.
 *
 * The new contribution is added here rather than left for `buildClaudeRequest`
 * to pick up out of the history, because the combine flow merges several rows
 * into one turn and a row's approval status changes as the pipeline runs. Doing
 * it explicitly means the request contains exactly the blocks step 5 produced,
 * in the order step 5 produced them.
 */
function appendUserTurn(request: ClaudeRequestShape, content: string): ClaudeRequestShape {
  const messages = [...request.messages]
  const last = messages[messages.length - 1]
  if (last && last.role === 'user') {
    // Two consecutive user turns are legal but merging matches what
    // `buildClaudeRequest` does with the rest of the transcript, so a replay of
    // this same conversation later produces an identical shape.
    messages[messages.length - 1] = { role: 'user', content: `${last.content}\n\n${content}` }
  } else {
    messages.push({ role: 'user', content })
  }
  return { ...request, messages }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Step 3 — store the original message with the *user-scoped* client.
 *
 * `validateSecurity` has already said yes. Writing through the user's own
 * session anyway means the `messages_insert_members` policy is evaluated as a
 * second, independent check by the database. If it refuses a write our
 * capability layer approved, the two have drifted — that is a real finding, so
 * it is logged loudly and surfaced rather than retried with the service role.
 */
async function storeOriginalMessage(args: {
  ctx: SecurityContext
  content: string
  senderType: SenderType
  approvalStatus: ApprovalStatus
}): Promise<ValidationResult<Message>> {
  const supabase = await createServerSupabase()

  const payload: Database['public']['Tables']['messages']['Insert'] = {
    room_id: args.ctx.room.id,
    // Identity comes from the verified session carried in `ctx`, never from the
    // request. There is no field a caller can set to author as someone else.
    sender_id: args.ctx.user.id,
    sender_type: args.senderType,
    original_content: args.content,
    approval_status: args.approvalStatus,
  }

  // `insert(… as never)`: postgrest-js 2.112 needs a `Relationships` key on every
  // table in the schema mirror, and `database.types.ts` has none, so the builder
  // argument degrades to `never`. The payload above is still checked against the
  // real Insert type, so the cast is confined to this line.
  const { data, error } = await supabase
    .from('messages')
    .insert(payload as never)
    .select('*')
    .single<Message>()

  if (error) {
    // 42501 is Postgres' insufficient_privilege, which is what an RLS refusal
    // arrives as. Anything else is a constraint or transport failure.
    const rlsRefusal = error.code === '42501'
    console.error(
      rlsRefusal
        ? '[pipeline] RLS refused an insert that validateSecurity approved — capability layer and policy have drifted'
        : '[pipeline] message insert failed',
      { roomId: args.ctx.room.id, userId: args.ctx.user.id, code: error.code, message: error.message },
    )
    await recordAudit({
      roomId: args.ctx.room.id,
      actorId: args.ctx.user.id,
      action: 'security.denied',
      metadata: {
        reason: rlsRefusal ? 'rls.insert_rejected' : 'message.insert_failed',
        postgres_code: error.code,
        postgres_message: error.message,
      },
    })
    return rlsRefusal
      ? validationFailure(
          'message.rls_rejected',
          'The database refused to store that message even though your role allows it. An administrator needs to look at the room policies.',
          403,
        )
      : validationFailure('message.insert_failed', 'Could not save your message. Please try again.', 500)
  }

  if (!data) {
    return validationFailure('message.insert_failed', 'Could not save your message. Please try again.', 500)
  }

  // Independent read-back: proves the row committed rather than trusting the
  // insert's own echo of it.
  return verifyMessageStored({ messageId: data.id, roomId: args.ctx.room.id })
}

/**
 * Writes the exact text handed to Claude onto the row.
 *
 * Service-role, because on the open path the author is a collaborator and
 * `messages_update_owner` admits only the Core Prompter — a collaborator cannot
 * be allowed to rewrite message rows generally, but the pipeline has to record
 * what it sent so a later replay reproduces the same conversation.
 */
async function persistProcessedContent(messageId: string, processed: string): Promise<void> {
  const admin = createAdminClient()
  const patch: Database['public']['Tables']['messages']['Update'] = { processed_content: processed }
  const { error } = await admin.from('messages').update(patch as never).eq('id', messageId)
  if (error) {
    // Not fatal: the turn still goes out, and `turnContent` falls back to
    // rebuilding the envelope from `original_content` on the next replay.
    console.error('[pipeline] processed_content write failed', { messageId, message: error.message })
  }
}

async function markMessageError(messageId: string, text: string): Promise<void> {
  const admin = createAdminClient()
  const patch: Database['public']['Tables']['messages']['Update'] = { error: text }
  const { error } = await admin.from('messages').update(patch as never).eq('id', messageId)
  if (error) console.error('[pipeline] error flag write failed', { messageId, message: error.message })
}

/** Reads the room's Claude session state, tolerating a room provisioned before the trigger existed. */
async function readConversationState(roomId: string): Promise<ClaudeConversationState> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('claude_sessions')
    .select('*')
    .eq('room_id', roomId)
    .maybeSingle<ClaudeSession>()
  return data?.conversation_state ?? { ...DEFAULT_CONVERSATION_STATE }
}

/**
 * Step 9 (second half) — session bookkeeping.
 *
 * Service-role: on the open path the turn is caused by a collaborator, and
 * `claude_sessions_update_owner` admits only the Core Prompter.
 *
 * Read-modify-write, so two turns that overlap can lose a count. The
 * `claudePerRoom` bucket bounds how often that can happen and these numbers are
 * observability, not correctness — a transactional counter would cost a round
 * trip on every message to protect a statistic.
 */
async function writeConversationState(roomId: string, next: ClaudeConversationState): Promise<void> {
  const admin = createAdminClient()
  const patch: Database['public']['Tables']['claude_sessions']['Update'] = { conversation_state: next }
  const { error } = await admin.from('claude_sessions').update(patch as never).eq('room_id', roomId)
  if (error) {
    console.error('[pipeline] conversation_state write failed', { roomId, message: error.message })
  }
}

/**
 * Turns a failed Claude turn into something every participant can see.
 *
 * A silent dead end is the worst outcome in a shared room: one person watches
 * their message vanish while everybody else sees nothing at all. The system row
 * lands in the same realtime stream as any other message, so the whole room gets
 * the same explanation at the same time.
 */
async function recordTurnFailure(args: {
  roomId: string
  actorId: string
  code: string
  message: string
}): Promise<void> {
  const admin = createAdminClient()

  const payload: Database['public']['Tables']['messages']['Insert'] = {
    room_id: args.roomId,
    sender_id: null,
    sender_type: 'system',
    original_content: args.message,
    approval_status: 'sent',
    error: args.code,
  }
  const { error } = await admin.from('messages').insert(payload as never)
  if (error) console.error('[pipeline] system error row insert failed', { roomId: args.roomId, message: error.message })

  const state = await readConversationState(args.roomId)
  await writeConversationState(args.roomId, { ...state, last_error: `${args.code}: ${args.message}` })

  await recordAudit({
    roomId: args.roomId,
    actorId: args.actorId,
    action: 'claude.error',
    metadata: { code: args.code, message: args.message },
  })
}

// ---------------------------------------------------------------------------
// Steps 6–9
// ---------------------------------------------------------------------------

/** Maps a typed Claude failure onto an HTTP status the route can return as-is. */
function claudeErrorStatus(error: ClaudeError): number {
  switch (error.code) {
    case 'rate_limit':
      return 429
    case 'authentication':
    case 'permission':
    case 'invalid_request':
      // A misconfigured key, an unavailable model or a malformed request are all
      // server-side problems; the caller cannot fix them by changing their input.
      return 500
    default:
      return 502
  }
}

const retryableClaudeFailure = (error: unknown): boolean =>
  // `ClaudeError` has already classified itself (a rate limit is worth waiting
  // out, a bad API key never is). Anything else falls back to the transport-level
  // heuristic.
  error instanceof ClaudeError ? error.retryable : isTransientFailure(error)

interface DispatchResult {
  assistantMessage: Message
  warnings: ValidationIssue[]
}

async function dispatchToClaude(args: {
  roomId: string
  roomName: string
  actorId: string
  transcript: TranscriptContext
  /** Structured contribution blocks, in the order they should reach Claude. */
  blocks: string[]
}): Promise<ValidationResult<DispatchResult>> {
  const warnings: ValidationIssue[] = []

  // ---- 6. add conversation context --------------------------------------
  const system = buildSystemPrompt({
    roomName: args.roomName,
    corePrompterName: args.transcript.corePrompterName,
    participants: args.transcript.participants,
  })

  const request = appendUserTurn(
    buildClaudeRequest({
      system,
      history: args.transcript.history,
      corePrompterName: args.transcript.corePrompterName,
      roomName: args.roomName,
    }),
    // Several contributors become one turn: the blocks are already individually
    // framed and labelled, so joining them cannot let one participant's text be
    // read as another's.
    args.blocks.join('\n\n'),
  )

  // ---- 7. send to Claude -------------------------------------------------
  // The functionality validator gates the request. Together with step 2 this is
  // the "both validators approved" condition; nothing below runs otherwise.
  const requestCheck = verifyClaudeRequest(request)
  if (!requestCheck.ok || !requestCheck.data) {
    const issue = requestCheck.issues[0]
    await recordTurnFailure({
      roomId: args.roomId,
      actorId: args.actorId,
      code: issue?.code ?? 'claude_request.invalid',
      message: issue?.message ?? 'The request to Claude could not be built.',
    })
    return { ok: false, issues: requestCheck.issues, status: requestCheck.status }
  }
  const verifiedRequest = requestCheck.data
  warnings.push(...requestCheck.issues)

  await recordAudit({
    roomId: args.roomId,
    actorId: args.actorId,
    action: 'claude.request',
    metadata: {
      model: verifiedRequest.model,
      turns: verifiedRequest.messages.length,
      blocks: args.blocks.length,
    },
  })

  let turn: ClaudeTurnResult
  try {
    // Retries cover transient failures only — a refused or malformed request
    // would fail identically every time, and re-sending a contribution the API
    // already rejected is worse than reporting it.
    turn = await withRetry('claude.turn', () => runClaudeTurn(verifiedRequest), {
      retryable: retryableClaudeFailure,
    })
  } catch (cause) {
    const failure =
      cause instanceof ClaudeError
        ? { code: `claude.${cause.code}`, message: cause.message, status: claudeErrorStatus(cause) }
        : {
            code: 'claude.failed',
            message: cause instanceof Error ? cause.message : 'Claude could not be reached.',
            status: 502,
          }
    await recordTurnFailure({ roomId: args.roomId, actorId: args.actorId, ...failure })
    return validationFailure(failure.code, failure.message, failure.status)
  }

  const responseCheck = verifyClaudeResponse(turn.text, turn.stopReason)
  if (!responseCheck.ok || !responseCheck.data) {
    const issue = responseCheck.issues[0]
    await recordTurnFailure({
      roomId: args.roomId,
      actorId: args.actorId,
      code: issue?.code ?? 'claude.unusable_response',
      message: issue?.message ?? 'Claude returned a response we could not use.',
    })
    return { ok: false, issues: responseCheck.issues, status: responseCheck.status }
  }
  warnings.push(...responseCheck.issues)

  // ---- 8. save Claude's response ----------------------------------------
  // Service-role: no RLS policy grants `sender_type = 'assistant'` to any
  // client role, which is what stops a member from forging a reply from Claude.
  const admin = createAdminClient()
  const assistantPayload: Database['public']['Tables']['messages']['Insert'] = {
    room_id: args.roomId,
    sender_id: null,
    sender_type: 'assistant',
    original_content: responseCheck.data,
    approval_status: 'sent',
  }
  const inserted = await admin
    .from('messages')
    .insert(assistantPayload as never)
    .select('*')
    .single<Message>()

  if (inserted.error || !inserted.data) {
    const message = inserted.error?.message ?? 'no row returned'
    console.error('[pipeline] assistant insert failed', { roomId: args.roomId, message })
    await recordTurnFailure({
      roomId: args.roomId,
      actorId: args.actorId,
      code: 'assistant.insert_failed',
      message: 'Claude replied, but the reply could not be saved. Nothing was lost — try again.',
    })
    return validationFailure('assistant.insert_failed', 'Claude replied but the reply was not saved.', 500)
  }

  const persisted = await verifyAssistantPersisted(inserted.data.id)
  if (!persisted.ok || !persisted.data) {
    return { ok: false, issues: persisted.issues, status: persisted.status }
  }

  // ---- 9. broadcast ------------------------------------------------------
  // Nothing to call. The INSERT above is itself the broadcast: `messages` is in
  // the `supabase_realtime` publication, so every subscribed client receives the
  // row through `postgres_changes` without the server pushing anything. An
  // explicit fan-out here would double-deliver and would bypass RLS, which is
  // what filters the stream per subscriber.
  const state = await readConversationState(args.roomId)
  await writeConversationState(args.roomId, {
    turn_count: state.turn_count + 1,
    last_message_id: persisted.data.id,
    total_input_tokens: state.total_input_tokens + turn.inputTokens,
    total_output_tokens: state.total_output_tokens + turn.outputTokens,
    // A turn that succeeded clears the previous failure, so the banner does not
    // outlive the problem it described.
    last_error: null,
  })

  await recordAudit({
    roomId: args.roomId,
    actorId: args.actorId,
    action: 'claude.response',
    targetId: persisted.data.id,
    metadata: {
      model: turn.model,
      stop_reason: turn.stopReason,
      input_tokens: turn.inputTokens,
      output_tokens: turn.outputTokens,
    },
  })

  return validationSuccess({ assistantMessage: persisted.data, warnings })
}

// ---------------------------------------------------------------------------
// Pending-queue helpers
// ---------------------------------------------------------------------------

/**
 * Loads the pending rows an approve/combine call names, in the order they were
 * written.
 *
 * Service-role read, then every invariant is re-checked here: the row belongs to
 * *this* room, it is still pending, and it is a human turn. A message id from
 * another room would otherwise let an owner pull a foreign contribution into
 * their own conversation.
 */
async function loadPendingMessages(
  roomId: string,
  messageIds: string[],
): Promise<ValidationResult<Message[]>> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('messages')
    .select('*')
    .in('id', messageIds)
    .eq('room_id', roomId)
    .returns<Message[]>()

  if (error) {
    console.error('[pipeline] pending lookup failed', { roomId, message: error.message })
    return validationFailure('message.lookup_failed', 'Could not load those contributions.', 500)
  }

  const rows = data ?? []
  const byId = new Map(rows.map((row) => [row.id, row]))

  const missing = messageIds.filter((id) => !byId.has(id))
  if (missing.length > 0) {
    return validationFailure(
      'message.not_found',
      missing.length === 1
        ? 'That contribution is not in this room.'
        : `${missing.length} of those contributions are not in this room.`,
      404,
    )
  }

  const notPending = rows.filter((row) => row.approval_status !== 'pending')
  if (notPending.length > 0) {
    return validationFailure(
      'message.not_pending',
      'That contribution has already been handled. Refresh to see its current state.',
      409,
    )
  }

  const notHuman = rows.filter(
    (row) => row.sender_type !== 'collaborator' && row.sender_type !== 'core_prompter',
  )
  if (notHuman.length > 0) {
    return validationFailure('message.not_a_contribution', 'Only participant messages can be approved.', 400)
  }

  return validationSuccess(
    [...rows].sort((a, b) => {
      const left = Date.parse(a.created_at)
      const right = Date.parse(b.created_at)
      if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right
      return a.id.localeCompare(b.id)
    }),
  )
}

/**
 * Moves rows through the approval states.
 *
 * User-scoped: `messages_update_owner` admits only the room owner, and approving
 * is a Core-Prompter-only capability, so the caller is always allowed — which
 * makes the policy a genuine second check here rather than an obstacle.
 *
 * `expectStatus` makes the transition a compare-and-set. Between
 * `loadPendingMessages` and this write there is a window in which a second
 * request — a double-clicked Approve button, two tabs — could act on the same
 * row; adding the current status to the WHERE clause means the loser updates
 * nothing and is told so, instead of both of them sending the contribution.
 */
async function updateApproval(args: {
  messageIds: string[]
  patch: Database['public']['Tables']['messages']['Update']
  expectStatus?: ApprovalStatus
}): Promise<ValidationResult<Message[]>> {
  const supabase = await createServerSupabase()

  let query = supabase.from('messages').update(args.patch as never).in('id', args.messageIds)
  if (args.expectStatus) query = query.eq('approval_status', args.expectStatus)

  const { data, error } = await query.select('*').returns<Message[]>()

  if (error) {
    console.error('[pipeline] approval update failed', { message: error.message, code: error.code })
    return validationFailure(
      error.code === '42501' ? 'message.rls_rejected' : 'message.update_failed',
      'Could not update those contributions.',
      error.code === '42501' ? 403 : 500,
    )
  }
  if (!data || data.length !== args.messageIds.length) {
    return args.expectStatus
      ? validationFailure(
          'message.not_pending',
          'That contribution was already handled somewhere else. Refresh to see its current state.',
          409,
        )
      : validationFailure('message.update_failed', 'Could not update those contributions.', 500)
  }
  return validationSuccess(data)
}

/**
 * Puts approved-but-undelivered rows back in the queue after a failed turn.
 *
 * Without this the contribution would be stranded: `approval_status` reads as
 * `approved`, so the pending queue no longer offers it, but it never reached
 * Claude — and `buildClaudeRequest` treats `approved` as delivered, so it would
 * silently ride along on the *next* turn instead.
 */
async function revertToPending(messageIds: string[], reason: string): Promise<void> {
  const admin = createAdminClient()
  const patch: Database['public']['Tables']['messages']['Update'] = {
    approval_status: 'pending',
    approved_by: null,
    approved_at: null,
    error: reason,
  }
  const { error } = await admin.from('messages').update(patch as never).in('id', messageIds)
  if (error) console.error('[pipeline] revert to pending failed', { messageIds, message: error.message })
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export async function submitContribution(args: {
  roomId: string
  content: string
}): Promise<ValidationResult<SubmitResult>> {
  // ---- 1. identify the sender + 2. confirm permission --------------------
  // Both live inside `validateSecurity`: it resolves the caller from the
  // verified session and then runs the ordered gate chain. Nothing in `args`
  // names a sender, so there is no identity to forge.
  const security = await validateSecurity({
    roomId: args.roomId,
    action: 'room.send_message',
    content: args.content,
  })
  if (!security.ok || !security.data) {
    return { ok: false, issues: security.issues, status: security.status }
  }
  const ctx = security.data
  const warnings: ValidationIssue[] = [...security.issues]

  const content = normaliseMessage(args.content)
  const senderType: SenderType = ctx.membership.role === 'core_prompter' ? 'core_prompter' : 'collaborator'
  const queued = requiresApproval(ctx.membership, ctx.roomCtx)

  // ---- 3. store the original message -------------------------------------
  const stored = await storeOriginalMessage({
    ctx,
    content,
    senderType,
    approvalStatus: queued ? 'pending' : 'sent',
  })
  if (!stored.ok || !stored.data) {
    return { ok: false, issues: stored.issues, status: stored.status }
  }
  const message = stored.data

  await recordAudit({
    roomId: ctx.room.id,
    actorId: ctx.user.id,
    action: 'message.sent',
    targetId: message.id,
    metadata: { sender_type: senderType, queued, injection_score: ctx.injection.score },
  })

  if (queued) {
    // Approval mode stops here, at step 3. The row is visible to the room (and
    // to the Core Prompter's queue) through realtime, but nothing was sent and
    // no Claude session state changed.
    return validationSuccess({ message, queued: true, assistantMessage: null, warnings })
  }

  // The roster is loaded before step 4 because the contribution header names the
  // Core Prompter, and that name lives on the owner's profile.
  const transcript = await loadTranscriptContext({
    roomId: ctx.room.id,
    ownerId: ctx.room.owner_id,
    // The row we just wrote is `sent`, so it would be replayed *and* appended.
    excludeIds: [message.id],
  })

  // ---- 4. label sender identity and role ---------------------------------
  // Taken from the room context, not from the message row: the profile and the
  // membership role are the two facts that decide how Claude is told to weigh
  // this turn, and both came from the verified session.
  const sender = {
    name: ctx.profile.display_name,
    email: ctx.profile.email,
    role: ctx.member.role,
  }

  // ---- 5. convert to a structured contribution ---------------------------
  const contribution = buildStructuredContribution({
    corePrompterName: transcript.corePrompterName,
    senderName: sender.name,
    senderRole: sender.role,
    senderEmail: sender.email,
    content,
    roomName: ctx.room.name,
  })
  await persistProcessedContent(message.id, contribution)

  // ---- 6–9 ---------------------------------------------------------------
  const dispatch = await dispatchToClaude({
    roomId: ctx.room.id,
    roomName: ctx.room.name,
    actorId: ctx.user.id,
    transcript,
    blocks: [contribution],
  })

  if (!dispatch.ok || !dispatch.data) {
    await markMessageError(message.id, dispatch.issues[0]?.message ?? 'Claude did not reply to this message.')
    return { ok: false, issues: dispatch.issues, status: dispatch.status }
  }

  return validationSuccess({
    message: { ...message, processed_content: contribution },
    queued: false,
    assistantMessage: dispatch.data.assistantMessage,
    warnings: [...warnings, ...dispatch.data.warnings],
  })
}

export async function approveAndSend(args: {
  roomId: string
  messageId: string
  editedContent?: string
}): Promise<ValidationResult<SubmitResult>> {
  // Steps 1 and 2 for the *approver*. `room.approve_message` resolves to the
  // Core Prompter alone, and it shares the `claudePerRoom` bucket with sending
  // so approving cannot be used to double the room's Claude budget.
  const security = await validateSecurity({
    roomId: args.roomId,
    action: 'room.approve_message',
    content: args.editedContent,
  })
  if (!security.ok || !security.data) {
    return { ok: false, issues: security.issues, status: security.status }
  }
  const ctx = security.data
  const warnings: ValidationIssue[] = [...security.issues]

  const pending = await loadPendingMessages(args.roomId, [args.messageId])
  if (!pending.ok || !pending.data) {
    return { ok: false, issues: pending.issues, status: pending.status }
  }
  const row = pending.data[0]

  // The edit is stored beside the original rather than over it: the room can
  // still see what the collaborator actually wrote, which is the difference
  // between an editor and a ghostwriter.
  const edited = args.editedContent === undefined ? null : normaliseMessage(args.editedContent)
  const editApplied = edited !== null && edited.length > 0 && edited !== row.original_content

  const approvedAt = new Date().toISOString()
  const approved = await updateApproval({
    messageIds: [row.id],
    expectStatus: 'pending',
    patch: {
      approval_status: 'approved',
      approved_by: ctx.user.id,
      approved_at: approvedAt,
      edited_content: editApplied ? edited : row.edited_content,
      error: null,
    },
  })
  if (!approved.ok || !approved.data) {
    return { ok: false, issues: approved.issues, status: approved.status }
  }
  const approvedRow = approved.data[0]

  if (editApplied) {
    await recordAudit({
      roomId: ctx.room.id,
      actorId: ctx.user.id,
      action: 'message.edited',
      targetId: row.id,
      metadata: { original_length: row.original_content.length, edited_length: edited.length },
    })
  }
  await recordAudit({
    roomId: ctx.room.id,
    actorId: ctx.user.id,
    action: 'message.approved',
    targetId: row.id,
    metadata: { edited: editApplied, author_id: row.sender_id },
  })

  const transcript = await loadTranscriptContext({
    roomId: ctx.room.id,
    ownerId: ctx.room.owner_id,
    // Now `approved`, so it would be replayed from the history as well as
    // appended as the new turn.
    excludeIds: [row.id],
  })

  // Steps 4 and 5, over the edited text when there is one — the prompt is built
  // from what will actually be sent, so the header's "Edited by the Core
  // Prompter" note and the body can never disagree.
  const contribution = contributionForRow({
    row: approvedRow,
    body: approvedRow.edited_content ?? approvedRow.original_content,
    transcript,
    roomName: ctx.room.name,
    approvedByName: transcript.corePrompterName,
  })
  await persistProcessedContent(row.id, contribution)

  const dispatch = await dispatchToClaude({
    roomId: ctx.room.id,
    roomName: ctx.room.name,
    actorId: ctx.user.id,
    transcript,
    blocks: [contribution],
  })

  if (!dispatch.ok || !dispatch.data) {
    await revertToPending([row.id], dispatch.issues[0]?.message ?? 'Claude did not reply to this contribution.')
    return { ok: false, issues: dispatch.issues, status: dispatch.status }
  }

  const sent = await updateApproval({
    messageIds: [row.id],
    expectStatus: 'approved',
    patch: { approval_status: 'sent' },
  })

  return validationSuccess({
    message: sent.ok && sent.data ? sent.data[0] : { ...approvedRow, processed_content: contribution },
    queued: false,
    assistantMessage: dispatch.data.assistantMessage,
    warnings: [...warnings, ...dispatch.data.warnings],
  })
}

export async function combineAndSend(args: {
  roomId: string
  messageIds: string[]
  content?: string
}): Promise<ValidationResult<SubmitResult>> {
  if (args.messageIds.length === 0) {
    return validationFailure('combine.empty', 'Select at least one contribution to combine.', 400)
  }

  const uniqueIds = [...new Set(args.messageIds)]

  const security = await validateSecurity({
    roomId: args.roomId,
    action: 'room.approve_message',
    content: args.content,
  })
  if (!security.ok || !security.data) {
    return { ok: false, issues: security.issues, status: security.status }
  }
  const ctx = security.data
  const warnings: ValidationIssue[] = [...security.issues]

  const pending = await loadPendingMessages(args.roomId, uniqueIds)
  if (!pending.ok || !pending.data) {
    return { ok: false, issues: pending.issues, status: pending.status }
  }
  const rows = pending.data

  const approvedAt = new Date().toISOString()
  const approved = await updateApproval({
    messageIds: rows.map((row) => row.id),
    expectStatus: 'pending',
    patch: {
      approval_status: 'approved',
      approved_by: ctx.user.id,
      approved_at: approvedAt,
      error: null,
    },
  })
  if (!approved.ok || !approved.data) {
    return { ok: false, issues: approved.issues, status: approved.status }
  }

  // The update returns rows in an unspecified order; `rows` is already sorted by
  // creation time and that order is what the combined turn must preserve.
  const approvedById = new Map(approved.data.map((row) => [row.id, row]))
  const orderedRows = rows.map((row) => approvedById.get(row.id) ?? row)

  // The Core Prompter's covering note becomes a real message rather than
  // invisible framing. Text that reaches Claude but appears nowhere in the
  // transcript would be a hole in the room's shared record.
  const note = args.content === undefined ? '' : normaliseMessage(args.content)
  let noteRow: Message | null = null
  if (note.length > 0) {
    const storedNote = await storeOriginalMessage({
      ctx,
      content: note,
      senderType: 'core_prompter',
      approvalStatus: 'sent',
    })
    if (!storedNote.ok || !storedNote.data) {
      await revertToPending(
        orderedRows.map((row) => row.id),
        'The combined turn was not sent.',
      )
      return { ok: false, issues: storedNote.issues, status: storedNote.status }
    }
    noteRow = storedNote.data
  }

  const excludeIds = orderedRows.map((row) => row.id)
  if (noteRow) excludeIds.push(noteRow.id)

  const transcript = await loadTranscriptContext({
    roomId: ctx.room.id,
    ownerId: ctx.room.owner_id,
    excludeIds,
  })

  // One structured block per contributor, in order. Each keeps its own author's
  // name, account and role in its header, so merging several people into a
  // single turn never merges their identities.
  const blocks: string[] = []
  for (const row of orderedRows) {
    const block = contributionForRow({
      row,
      body: row.edited_content ?? row.original_content,
      transcript,
      roomName: ctx.room.name,
      approvedByName: transcript.corePrompterName,
    })
    await persistProcessedContent(row.id, block)
    blocks.push(block)
  }

  if (noteRow) {
    const noteBlock = buildStructuredContribution({
      corePrompterName: transcript.corePrompterName,
      senderName: ctx.profile.display_name,
      senderRole: ctx.member.role,
      senderEmail: ctx.profile.email,
      content: note,
      roomName: ctx.room.name,
    })
    await persistProcessedContent(noteRow.id, noteBlock)
    blocks.push(noteBlock)
  }

  await recordAudit({
    roomId: ctx.room.id,
    actorId: ctx.user.id,
    action: 'message.approved',
    targetId: orderedRows[orderedRows.length - 1].id,
    metadata: {
      combined_message_ids: orderedRows.map((row) => row.id),
      contributor_ids: [...new Set(orderedRows.map((row) => row.sender_id).filter((id): id is string => id !== null))],
      note_message_id: noteRow?.id ?? null,
    },
  })

  const dispatch = await dispatchToClaude({
    roomId: ctx.room.id,
    roomName: ctx.room.name,
    actorId: ctx.user.id,
    transcript,
    blocks,
  })

  if (!dispatch.ok || !dispatch.data) {
    await revertToPending(
      orderedRows.map((row) => row.id),
      dispatch.issues[0]?.message ?? 'Claude did not reply to the combined contribution.',
    )
    if (noteRow) await markMessageError(noteRow.id, 'The combined turn was not delivered.')
    return { ok: false, issues: dispatch.issues, status: dispatch.status }
  }

  const sent = await updateApproval({
    messageIds: orderedRows.map((row) => row.id),
    expectStatus: 'approved',
    patch: { approval_status: 'sent' },
  })

  const lastOrdered = orderedRows[orderedRows.length - 1]
  return validationSuccess({
    // The Core Prompter's note when there is one, otherwise the last of the
    // combined contributions — whichever the room saw last.
    message: noteRow ?? (sent.ok && sent.data ? (sent.data.find((row) => row.id === lastOrdered.id) ?? lastOrdered) : lastOrdered),
    queued: false,
    assistantMessage: dispatch.data.assistantMessage,
    warnings: [...warnings, ...dispatch.data.warnings],
  })
}

export async function rejectContribution(args: {
  roomId: string
  messageId: string
  reason?: string
}): Promise<ValidationResult<Message>> {
  const security = await validateSecurity({ roomId: args.roomId, action: 'room.approve_message' })
  if (!security.ok || !security.data) {
    return { ok: false, issues: security.issues, status: security.status }
  }
  const ctx = security.data

  const pending = await loadPendingMessages(args.roomId, [args.messageId])
  if (!pending.ok || !pending.data) {
    return { ok: false, issues: pending.issues, status: pending.status }
  }
  const row = pending.data[0]

  const reason = args.reason === undefined ? null : normaliseMessage(args.reason)

  const rejected = await updateApproval({
    messageIds: [row.id],
    expectStatus: 'pending',
    patch: {
      approval_status: 'rejected',
      approved_by: ctx.user.id,
      approved_at: new Date().toISOString(),
      // Stored on the row so the author sees why, rather than watching their
      // message disappear from the queue with no explanation.
      error: reason && reason.length > 0 ? reason : null,
    },
  })
  if (!rejected.ok || !rejected.data) {
    return { ok: false, issues: rejected.issues, status: rejected.status }
  }

  await recordAudit({
    roomId: ctx.room.id,
    actorId: ctx.user.id,
    action: 'message.rejected',
    targetId: row.id,
    metadata: { author_id: row.sender_id, reason: reason ?? null },
  })

  return validationSuccess(rejected.data[0])
}
