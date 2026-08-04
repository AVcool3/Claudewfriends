/**
 * Agent 1 — the functionality validator.
 *
 * Answers "did that actually work?" at each step of the message pipeline: the
 * row really landed in Postgres, the request we are about to hand to Claude is
 * well formed, the response came back usable, and the assistant turn was
 * persisted. Everything here is deterministic and local — a model call to check
 * a model call would double the cost and the latency of every message while
 * being less reliable than reading the row back.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { ClaudeRequestShape } from '@/lib/claude/prompt'
import { CLAUDE_HISTORY_LIMIT, MAX_MESSAGE_LENGTH, validationFailure, validationSuccess } from '@/lib/types'
import type { Message, ValidationIssue, ValidationResult } from '@/lib/types'

export interface StoredMessageCheck {
  messageId: string
  roomId: string
}

/**
 * Ceiling on the serialised request.
 *
 * Worst case is `CLAUDE_HISTORY_LIMIT` messages at `MAX_MESSAGE_LENGTH` each,
 * plus the per-message contribution framing (~600 chars) and the system prompt.
 * The margin above that keeps us clear of the model's context window instead of
 * discovering the overflow as a 400 from the API mid-pipeline.
 */
const MAX_REQUEST_CHARS = Math.max(600_000, CLAUDE_HISTORY_LIMIT * (MAX_MESSAGE_LENGTH + 600))

const MAX_OUTPUT_TOKENS = 200_000

/**
 * Re-reads a message with the service-role client to confirm the write really
 * committed.
 *
 * The admin client is correct here specifically because this is a verification
 * read and not an access decision: whether the caller may act on this room was
 * settled upstream by `validateSecurity`, and running this read through RLS
 * would conflate "the insert silently failed" with "this row is not visible to
 * you", which are very different bugs.
 */
export async function verifyMessageStored(check: StoredMessageCheck): Promise<ValidationResult<Message>> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('messages')
    .select('*')
    .eq('id', check.messageId)
    // Explicit row type: see the note in `room-context.ts` about the missing
    // `Relationships` key in the schema mirror.
    .maybeSingle<Message>()

  if (error) {
    console.error('[functionality] message read-back failed', {
      messageId: check.messageId,
      message: error.message,
    })
    return validationFailure('message.readback_failed', 'Could not confirm the message was saved.', 500)
  }
  if (!data) {
    return validationFailure('message.not_stored', 'The message was not saved. Please try again.', 500)
  }
  if (data.room_id !== check.roomId) {
    // A mismatch means the id we were handed belongs to another room — a bug in
    // the caller, and a potential cross-room write if we carried on.
    console.error('[functionality] message stored under the wrong room', {
      messageId: check.messageId,
      expected: check.roomId,
      actual: data.room_id,
    })
    return validationFailure('message.room_mismatch', 'The message was saved against the wrong room.', 500)
  }
  if (data.original_content.trim().length === 0) {
    return validationFailure('message.empty_stored', 'The message was saved with no content.', 500)
  }

  return validationSuccess(data)
}

export function verifyClaudeRequest(request: ClaudeRequestShape): ValidationResult<ClaudeRequestShape> {
  const issues: ValidationIssue[] = []

  if (typeof request.model !== 'string' || request.model.trim().length === 0) {
    return validationFailure('claude_request.no_model', 'No Claude model was configured.', 500)
  }
  if (request.system.trim().length === 0) {
    // An empty system prompt would strip the framing rules that make
    // collaborator text safe to include, so this is a hard stop.
    return validationFailure('claude_request.empty_system', 'The system prompt is empty.', 500)
  }
  if (request.messages.length === 0) {
    return validationFailure('claude_request.no_messages', 'There is nothing to send to Claude.', 500)
  }
  if (request.messages[0].role !== 'user') {
    return validationFailure(
      'claude_request.bad_first_role',
      'The conversation must start with a user turn.',
      500,
    )
  }

  for (let i = 0; i < request.messages.length; i++) {
    const message = request.messages[i]
    if (message.role !== 'user' && message.role !== 'assistant') {
      return validationFailure(
        'claude_request.bad_role',
        `Message ${i} has an unsupported role.`,
        500,
      )
    }
    if (message.content.trim().length === 0) {
      // The API rejects empty content blocks outright; catching it here names
      // the offending index instead of surfacing an opaque upstream 400.
      return validationFailure(
        'claude_request.empty_message',
        `Message ${i} has no content.`,
        500,
      )
    }
    const previous = i > 0 ? request.messages[i - 1] : null
    if (previous && previous.role === message.role) {
      // Not fatal: two consecutive turns from the same role are mergeable, and
      // the client wrapper concatenates them. Flagged so an unintended
      // duplicate still shows up somewhere.
      issues.push({
        code: 'claude_request.non_alternating',
        message: `Messages ${i - 1} and ${i} share the role "${message.role}" and will be merged.`,
        severity: 'info',
      })
    }
  }

  if (!Number.isInteger(request.maxTokens) || request.maxTokens < 1 || request.maxTokens > MAX_OUTPUT_TOKENS) {
    return validationFailure(
      'claude_request.bad_max_tokens',
      `maxTokens must be between 1 and ${MAX_OUTPUT_TOKENS}.`,
      500,
    )
  }

  let serialisedSize = request.system.length
  for (const message of request.messages) serialisedSize += message.content.length
  if (serialisedSize > MAX_REQUEST_CHARS) {
    return validationFailure(
      'claude_request.too_large',
      'This conversation is too long to send. Start a new room to continue.',
      413,
    )
  }

  return validationSuccess(request, issues)
}

export function verifyClaudeResponse(text: string, stopReason: string | null): ValidationResult<string> {
  // `refusal` is checked before the text, because on a refusal the content
  // blocks are empty and "empty response" would be a misleading diagnosis.
  if (stopReason === 'refusal') {
    return validationFailure(
      'claude.refused',
      'Claude declined to answer this request. Rephrase the contribution and try again.',
      502,
      'warning',
    )
  }

  if (text.trim().length === 0) {
    if (stopReason === 'max_tokens') {
      return validationFailure(
        'claude.truncated_empty',
        'Claude hit the output limit before producing any text. Raise CLAUDE_MAX_TOKENS or shorten the request.',
        502,
      )
    }
    return validationFailure(
      'claude.empty_response',
      'Claude returned an empty response. Please try again.',
      502,
    )
  }

  if (stopReason === 'max_tokens') {
    // Partial text is still worth showing — the room sees what Claude got
    // through and the warning explains the abrupt ending.
    return validationSuccess(text, [
      {
        code: 'claude.truncated',
        message: 'Claude reached the output limit, so this reply is cut short. Ask it to continue.',
        severity: 'warning',
      },
    ])
  }

  return validationSuccess(text)
}

export async function verifyAssistantPersisted(messageId: string): Promise<ValidationResult<Message>> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('messages')
    .select('*')
    .eq('id', messageId)
    .maybeSingle<Message>()

  if (error) {
    console.error('[functionality] assistant read-back failed', { messageId, message: error.message })
    return validationFailure('assistant.readback_failed', 'Could not confirm Claude\'s reply was saved.', 500)
  }
  if (!data) {
    return validationFailure('assistant.not_stored', 'Claude replied but the reply was not saved.', 500)
  }
  if (data.sender_type !== 'assistant') {
    return validationFailure('assistant.wrong_sender_type', 'The saved reply is not an assistant turn.', 500)
  }
  if (data.original_content.trim().length === 0) {
    return validationFailure('assistant.empty_stored', 'Claude\'s reply was saved with no content.', 500)
  }

  return validationSuccess(data)
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

const MAX_BACKOFF_MS = 8_000

/**
 * Decorrelates concurrent retries in the same process. It is a counter rather
 * than a random seed because module-scope randomness is evaluated once at import
 * time — every isolate would then share the same "random" schedule and retry in
 * lockstep, which is the opposite of what jitter is for. Real randomness is
 * drawn per call inside `backoffDelay`.
 */
let retrySequence = 0

function backoffDelay(attempt: number, baseDelayMs: number): number {
  retrySequence = (retrySequence + 1) % 997
  const counterJitter = retrySequence / 997
  const jitter = (counterJitter + Math.random()) / 2
  const ceiling = Math.min(MAX_BACKOFF_MS, baseDelayMs * 2 ** (attempt - 1))
  // Equal jitter: never less than half the ceiling, so backoff still grows.
  return Math.round(ceiling * (0.5 + 0.5 * jitter))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null
  const candidate = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } }
  for (const value of [candidate.status, candidate.statusCode, candidate.response?.status]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])

const TRANSIENT_MESSAGE = /fetch failed|socket hang up|network|timed? ?out|temporarily unavailable/i

/**
 * Default retry predicate: transport failures, 429 and 5xx only.
 *
 * Every other 4xx is a statement that the request itself is wrong — a rejected
 * message, a bad model name, an over-long prompt. Retrying those cannot succeed
 * and, for a rejected message, would mean repeatedly re-submitting content the
 * upstream already refused.
 */
export function isTransientFailure(error: unknown): boolean {
  const status = statusOf(error)
  if (status !== null) {
    if (status === 408 || status === 429) return true
    return status >= 500
  }

  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true
  }

  if (error instanceof Error) {
    // A deliberate cancellation is not a failure to retry.
    if (error.name === 'AbortError') return false
    if (TRANSIENT_MESSAGE.test(error.message)) return true
    const cause = (error as { cause?: unknown }).cause
    if (cause !== undefined && cause !== error) return isTransientFailure(cause)
  }

  return false
}

export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts?: { attempts?: number; baseDelayMs?: number; retryable?: (e: unknown) => boolean },
): Promise<T> {
  const attempts = Math.max(1, opts?.attempts ?? 3)
  const baseDelayMs = opts?.baseDelayMs ?? 300
  const retryable = opts?.retryable ?? isTransientFailure

  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt === attempts || !retryable(error)) break

      const delay = backoffDelay(attempt, baseDelayMs)
      console.warn(`[retry] ${label} attempt ${attempt}/${attempts} failed; retrying in ${delay}ms`, {
        message: error instanceof Error ? error.message : String(error),
      })
      await sleep(delay)
    }
  }

  throw lastError
}
