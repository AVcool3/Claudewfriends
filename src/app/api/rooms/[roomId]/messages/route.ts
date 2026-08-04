import { NextResponse } from 'next/server'
import { z } from 'zod'

import { submitContribution } from '@/lib/server/pipeline'
import { MAX_MESSAGE_LENGTH } from '@/lib/types'
import type { ValidationIssue, ValidationResult } from '@/lib/types'

export const dynamic = 'force-dynamic'

/**
 * A payload ceiling, not the message limit.
 *
 * `normaliseMessage` strips invisible characters and collapses blank-line runs
 * before anything is measured, so the authoritative check is
 * `assertMessageLength` inside the security validator — it runs on the
 * normalised text and produces a message that names the real overage. This bound
 * only stops a multi-megabyte body from being parsed and normalised at all.
 */
const RAW_CONTENT_CEILING = MAX_MESSAGE_LENGTH * 4

const SendSchema = z.object({
  content: z
    .string()
    .min(1, 'A message cannot be empty.')
    .max(RAW_CONTENT_CEILING, 'That message is far too long to send.'),
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
    { error: issue?.message ?? 'That message could not be sent.', code: issue?.code, issues: result.issues },
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

  const parsed = SendSchema.safeParse(await readJson(request))
  if (!parsed.success) return invalidBody(parsed.error)

  // The room id comes from the path and the sender from the session — the body
  // carries the message text and nothing else, so there is no field here that
  // could name a different author or a different room.
  const result = await submitContribution({ roomId, content: parsed.data.content })
  if (!result.ok || !result.data) return failure(result)

  // 202 when the contribution is waiting for the Core Prompter: the request
  // succeeded but the effect the caller asked for — a reply from Claude — has
  // not happened yet, and the client renders the two states differently.
  return NextResponse.json(result.data, { status: result.data.queued ? 202 : 201 })
}
