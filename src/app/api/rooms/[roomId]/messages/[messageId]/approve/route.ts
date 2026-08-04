import { NextResponse } from 'next/server'
import { z } from 'zod'

import { approveAndSend } from '@/lib/server/pipeline'
import { MAX_MESSAGE_LENGTH } from '@/lib/types'
import type { ValidationIssue, ValidationResult } from '@/lib/types'

export const dynamic = 'force-dynamic'

const ApproveSchema = z.object({
  /**
   * The Core Prompter's edit of the contribution. Omitted means "send it as
   * written"; the pipeline stores an edit in `edited_content` beside the
   * original so the room can still see what the author actually typed.
   */
  content: z.string().max(MAX_MESSAGE_LENGTH * 4, 'That edit is far too long.').optional(),
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
    { error: issue?.message ?? 'That contribution could not be approved.', code: issue?.code, issues: result.issues },
    { status: result.status ?? 400 },
  )
}

async function readJson(request: Request): Promise<unknown> {
  // An empty body is the common case here — "approve as written" needs no JSON.
  try {
    return await request.json()
  } catch {
    return {}
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ roomId: string; messageId: string }> },
) {
  const { roomId, messageId } = await ctx.params

  const parsed = ApproveSchema.safeParse(await readJson(request))
  if (!parsed.success) return invalidBody(parsed.error)

  const result = await approveAndSend({ roomId, messageId, editedContent: parsed.data.content })
  if (!result.ok || !result.data) return failure(result)

  return NextResponse.json(result.data, { status: 200 })
}
