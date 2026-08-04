import { NextResponse } from 'next/server'
import { z } from 'zod'

import { combineAndSend } from '@/lib/server/pipeline'
import { MAX_MESSAGE_LENGTH } from '@/lib/types'
import type { ValidationIssue, ValidationResult } from '@/lib/types'

export const dynamic = 'force-dynamic'

/**
 * How many pending contributions may go into one turn.
 *
 * Bounded because every id costs a row read and a structured block in the
 * prompt; without a ceiling a single request could assemble a turn large enough
 * to blow the context window, which `verifyClaudeRequest` would then reject
 * after the work had already been done.
 */
const MAX_COMBINED = 20

const CombineSchema = z.object({
  messageIds: z
    .array(z.uuid('That is not a valid message id.'))
    .min(1, 'Select at least one contribution to combine.')
    .max(MAX_COMBINED, `You can combine up to ${MAX_COMBINED} contributions at once.`),
  /** Optional covering note from the Core Prompter, sent as their own turn. */
  content: z.string().max(MAX_MESSAGE_LENGTH * 4, 'That note is far too long.').optional(),
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
    { error: issue?.message ?? 'Those contributions could not be sent.', code: issue?.code, issues: result.issues },
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

export async function POST(request: Request, ctx: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await ctx.params

  const parsed = CombineSchema.safeParse(await readJson(request))
  if (!parsed.success) return invalidBody(parsed.error)

  const result = await combineAndSend({
    roomId,
    messageIds: parsed.data.messageIds,
    content: parsed.data.content,
  })
  if (!result.ok || !result.data) return failure(result)

  return NextResponse.json(result.data, { status: 200 })
}
