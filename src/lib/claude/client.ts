import 'server-only'

import Anthropic, {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk'

import type { ClaudeRequestShape } from '@/lib/claude/prompt'
import { serverEnv } from '@/lib/env'

/**
 * The Anthropic SDK wrapper.
 *
 * `server-only` above is the hard boundary: this module reads
 * `serverEnv.anthropicApiKey`, and importing it from anything with `use client`
 * is a build error rather than a leaked key.
 */

export type ClaudeErrorCode =
  | 'authentication'
  | 'permission'
  | 'invalid_request'
  | 'rate_limit'
  | 'overloaded'
  | 'server_error'
  | 'connection'
  | 'aborted'
  | 'unknown'

export interface ClaudeErrorOptions {
  status?: number | null
  retryAfterSeconds?: number | null
  retryable?: boolean
  cause?: unknown
}

/**
 * Typed failure from a Claude turn.
 *
 * `code` and `retryable` exist so the pipeline can decide what to do without
 * pattern-matching on message text: a rate limit is worth waiting out, a bad API
 * key never is. `status` is also carried because the shared `withRetry` helper's
 * default predicate reads it, so a ClaudeError classifies correctly there too.
 */
export class ClaudeError extends Error {
  readonly code: ClaudeErrorCode
  readonly status: number | null
  readonly retryAfterSeconds: number | null
  readonly retryable: boolean

  constructor(code: ClaudeErrorCode, message: string, options: ClaudeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ClaudeError'
    this.code = code
    this.status = options.status ?? null
    this.retryAfterSeconds = options.retryAfterSeconds ?? null
    this.retryable = options.retryable ?? false
  }
}

export interface ClaudeTurnResult {
  text: string
  stopReason: string | null
  inputTokens: number
  outputTokens: number
  model: string
}

/**
 * Request fields the installed SDK's types predate.
 *
 * `@anthropic-ai/sdk@0.68` still types `thinking` as the fixed-budget shape and
 * has no `output_config` at all, but claude-opus-5 rejects `budget_tokens` with
 * a 400 and takes both of the fields below on the wire. Declaring them here and
 * casting once at the call site keeps every other field type-checked, which
 * typing the whole call loosely would not.
 */
interface AdaptiveThinkingParams {
  thinking: { type: 'adaptive' }
  output_config: { effort: typeof serverEnv.claudeEffort }
}

type AdaptiveStreamParams = Omit<Anthropic.MessageStreamParams, 'thinking'> & AdaptiveThinkingParams

let cachedClient: Anthropic | null = null

function getClient(): Anthropic {
  if (cachedClient) return cachedClient
  cachedClient = new Anthropic({
    // Read here rather than at module scope: `serverEnv.anthropicApiKey` throws
    // when unset, and evaluating it on import would break `next build` on a
    // machine that only has the public env vars.
    apiKey: serverEnv.anthropicApiKey,
    // Retry policy belongs to the pipeline, which already backs off through
    // `withRetry` and can see `ClaudeError.retryable`. Stacking the SDK's own
    // retries underneath would multiply the worst case of a stalled turn.
    maxRetries: 0,
  })
  return cachedClient
}

/** Pulls the API's own error type (`overloaded_error`, ...) out of the body. */
function apiErrorType(error: APIError): string | null {
  const body: unknown = error.error
  if (typeof body !== 'object' || body === null) return null
  const inner = (body as { error?: unknown }).error
  if (typeof inner !== 'object' || inner === null) return null
  const type = (inner as { type?: unknown }).type
  return typeof type === 'string' ? type : null
}

function retryAfterSeconds(error: APIError): number | null {
  const header = error.headers?.get('retry-after')
  if (!header) return null
  const seconds = Number.parseInt(header, 10)
  // The header may also be an HTTP date; in that case we simply have no hint,
  // which is better than reporting a nonsense delay.
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

function statusOf(error: APIError): number | null {
  return typeof error.status === 'number' ? error.status : null
}

function toClaudeError(error: unknown): ClaudeError {
  if (error instanceof ClaudeError) return error

  // Order matters: every class below extends APIError, so the generic case has
  // to come last.
  if (error instanceof AuthenticationError) {
    return new ClaudeError(
      'authentication',
      'Claude rejected the API key. Check ANTHROPIC_API_KEY on the server.',
      { status: statusOf(error), cause: error },
    )
  }

  if (error instanceof PermissionDeniedError) {
    return new ClaudeError(
      'permission',
      'This API key is not allowed to use the configured Claude model.',
      { status: statusOf(error), cause: error },
    )
  }

  if (error instanceof RateLimitError) {
    const wait = retryAfterSeconds(error)
    return new ClaudeError(
      'rate_limit',
      wait === null
        ? 'Claude is rate limiting this workspace. Try again shortly.'
        : `Claude is rate limiting this workspace. Try again in ${wait}s.`,
      { status: statusOf(error), retryAfterSeconds: wait, retryable: true, cause: error },
    )
  }

  if (error instanceof APIUserAbortError) {
    // A cancelled request is a decision someone made, not a failure to retry.
    return new ClaudeError('aborted', 'The request to Claude was cancelled.', { cause: error })
  }

  if (error instanceof APIConnectionError) {
    return new ClaudeError('connection', 'Could not reach Claude. Please try again.', {
      retryable: true,
      cause: error,
    })
  }

  if (error instanceof APIError) {
    const status = statusOf(error)
    const type = apiErrorType(error)

    if (status === 529 || type === 'overloaded_error') {
      return new ClaudeError('overloaded', 'Claude is overloaded right now. Please try again.', {
        status,
        retryAfterSeconds: retryAfterSeconds(error),
        retryable: true,
        cause: error,
      })
    }

    if (status !== null && status >= 500) {
      return new ClaudeError('server_error', 'Claude had a server error. Please try again.', {
        status,
        retryable: true,
        cause: error,
      })
    }

    if (status !== null && status >= 400) {
      // 4xx means the request itself is wrong — an unknown model, an over-long
      // prompt, a malformed turn. Retrying sends the same broken request again.
      return new ClaudeError(
        'invalid_request',
        `Claude rejected the request (${type ?? `HTTP ${status}`}).`,
        { status, cause: error },
      )
    }

    return new ClaudeError('unknown', error.message || 'Claude returned an unexpected error.', {
      status,
      cause: error,
    })
  }

  return new ClaudeError('unknown', 'Claude request failed for an unknown reason.', { cause: error })
}

export async function runClaudeTurn(request: ClaudeRequestShape): Promise<ClaudeTurnResult> {
  if (request.messages.length === 0) {
    // Fail with our own code instead of paying a round trip for the API's 400.
    throw new ClaudeError('invalid_request', 'There is nothing to send to Claude.')
  }

  const params: AdaptiveStreamParams = {
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    thinking: { type: 'adaptive' },
    output_config: { effort: serverEnv.claudeEffort },
  }

  let message: Anthropic.Message
  try {
    // Streamed even though we only want the final message: `max_tokens` covers
    // thinking plus visible output, so a high-effort turn can run well past the
    // point where a non-streaming HTTP request times out.
    message = await getClient()
      .messages.stream(params as unknown as Anthropic.MessageStreamParams)
      .finalMessage()
  } catch (error) {
    throw toClaudeError(error)
  }

  const stopReason: string | null = message.stop_reason

  const usage = {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  }

  if (stopReason === 'refusal') {
    // Checked before touching `content`: a refusal comes back as HTTP 200 with
    // an empty or partial content array, so indexing into it would throw. The
    // usage is still real and still billed, so it is reported either way.
    return { text: '', stopReason, model: message.model, ...usage }
  }

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    // Several text blocks only appear here when something (a thinking block)
    // split the reply, so a paragraph break is the faithful join.
    .join('\n\n')
    .trim()

  return { text, stopReason, model: message.model, ...usage }
}
