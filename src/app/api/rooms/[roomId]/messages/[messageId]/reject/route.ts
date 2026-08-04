import { NextResponse } from 'next/server'
import { z } from 'zod'

import { rejectContribution } from '@/lib/server/pipeline'
import type { ValidationIssue, ValidationResult } from '@/lib/types'

export const dynamic = 'force-dynamic'

const RejectSchema = z.object({
  /** Shown to the author on their own message, so a rejection is never silent. */
  reason: z.string().max(1000, 'Keep the reason under 1000 characters.').optional(),
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
    { error: issue?.message ?? 'That contribution could not be rejected.', code: issue?.code, issues: result.issues },
    { status: result.status ?? 400 },
  )
}

async function readJson(request: Request): Promise<unknown> {
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

  const parsed = RejectSchema.safeParse(await readJson(request))
  if (!parsed.success) return invalidBody(parsed.error)

  const result = await rejectContribution({ roomId, messageId, reason: parsed.data.reason })
  if (!result.ok || !result.data) return failure(result)

  return NextResponse.json({ message: result.data }, { status: 200 })
}
