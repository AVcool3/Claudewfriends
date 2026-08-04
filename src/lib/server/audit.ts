/**
 * Append-only audit trail.
 *
 * Writes go through the service-role client because `audit_logs` is deliberately
 * unreadable and unwritable by members: a Core Prompter should not be able to
 * edit the record of what they did in their own room, and RLS cannot express
 * "insert-only, nobody selects".
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { Database, Json } from '@/lib/database.types'
import type { AuditAction } from '@/lib/types'

/**
 * Key names that must never be persisted. Audit metadata is assembled ad hoc at
 * many call sites, so the safe default is to filter at the sink rather than to
 * trust every caller to remember.
 */
const SENSITIVE_KEY = /token|key|secret|password/i

/** Guards against a pathological nested object turning one audit row into a blob. */
const MAX_DEPTH = 6
const MAX_ARRAY_ITEMS = 50
const MAX_STRING_LENGTH = 2000

function toJson(value: unknown, depth: number): Json {
  if (value === null || value === undefined) return null

  switch (typeof value) {
    case 'string':
      return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value
    case 'number':
      // NaN/Infinity are not valid JSON and Postgres rejects them.
      return Number.isFinite(value) ? value : String(value)
    case 'boolean':
      return value
    case 'bigint':
      return value.toString()
    default:
      break
  }

  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) return `${value.name}: ${value.message}`

  if (depth >= MAX_DEPTH) return '[truncated]'

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => toJson(item, depth + 1))
  }

  if (typeof value === 'object') {
    const out: Record<string, Json> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) {
        out[key] = '[redacted]'
        continue
      }
      if (typeof item === 'function' || typeof item === 'symbol') continue
      out[key] = toJson(item, depth + 1)
    }
    return out
  }

  return String(value)
}

/** Strips credential-shaped keys from a metadata object before it is persisted. */
export function sanitiseAuditMetadata(metadata: Record<string, unknown>): Json {
  const sanitised = toJson(metadata, 0)
  // `toJson` on a plain object always yields an object; the guard keeps the
  // return type honest without a cast.
  return sanitised !== null && typeof sanitised === 'object' && !Array.isArray(sanitised)
    ? sanitised
    : {}
}

export async function recordAudit(entry: {
  roomId: string | null
  actorId: string | null
  action: AuditAction
  targetId?: string | null
  metadata?: Record<string, unknown>
}): Promise<void> {
  // Never throws. An audit write is observability, not correctness: failing a
  // user's message because the log table was briefly unavailable would be a
  // worse outcome than a gap in the trail, so every failure path here degrades
  // to console.error and returns.
  try {
    const admin = createAdminClient()
    const payload: Database['public']['Tables']['audit_logs']['Insert'] = {
      room_id: entry.roomId,
      actor_id: entry.actorId,
      action: entry.action,
      target_id: entry.targetId ?? null,
      metadata: sanitiseAuditMetadata(entry.metadata ?? {}),
    }
    // The cast is confined to this one line and the payload above is still
    // checked against the real schema type. postgrest-js 2.112 requires each
    // table in the schema mirror to carry a `Relationships` key; without it the
    // whole `Database` type fails its `GenericSchema` constraint and every
    // builder argument degrades to `never`. Fixing `database.types.ts` removes
    // the need for this.
    const { error } = await admin.from('audit_logs').insert(payload as never)
    if (error) {
      console.error('[audit] insert failed', { action: entry.action, message: error.message })
    }
  } catch (cause) {
    console.error('[audit] insert threw', {
      action: entry.action,
      message: cause instanceof Error ? cause.message : String(cause),
    })
  }
}
