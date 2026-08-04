'use client'

/**
 * One row of the transcript.
 *
 * The spec's central requirement is that a reader can tell at a glance whose
 * words they are looking at, because in this app the Core Prompter's account is
 * the one Claude actually answers to — every collaborator's text reaches the
 * model wrapped in that person's session. The three visual treatments below are
 * that distinction: amber for the Core Prompter, neutral for everyone else,
 * indigo for Claude.
 */

import { useEffect, useState } from 'react'

import Avatar from '@/components/ui/Avatar'
import Badge from '@/components/ui/Badge'
import { ROLE_LABELS, type MessageWithSender, type Role } from '@/lib/types'

/**
 * Shown beside Claude's name. The room's real model lives on `claude_sessions`
 * and is not threaded into the client yet; this matches the `CLAUDE_MODEL`
 * default in `env.ts`.
 */
export const DEFAULT_CLAUDE_MODEL_LABEL = 'Opus 5'

export interface MessageBubbleProps {
  message: MessageWithSender
  /** False when this row continues a run from the same sender. */
  showHeader: boolean
  isOwn: boolean
  modelLabel?: string | null
}

function relativeLabel(iso: string, now: number): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return ''
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(then).toLocaleDateString()
}

/**
 * Relative time is a hydration hazard twice over: `Date.now()` differs between
 * the render on the server and the one in the browser, and `toLocaleString()`
 * depends on a timezone the server does not have. So the first render — the one
 * React compares against the server HTML — uses only the ISO string itself, and
 * the human-readable forms are swapped in from an effect after hydration.
 */
function useTimestamp(iso: string): { label: string; title: string } {
  const [stamp, setStamp] = useState(() => ({ label: iso.slice(11, 16), title: iso }))

  useEffect(() => {
    function apply() {
      setStamp({ label: relativeLabel(iso, Date.now()), title: new Date(iso).toLocaleString() })
    }
    apply()
    const timer = window.setInterval(apply, 60_000)
    return () => window.clearInterval(timer)
  }, [iso])

  return stamp
}

function roleOf(message: MessageWithSender): Role {
  if (message.sender_role) return message.sender_role
  // A sender whose membership has since been removed leaves no live role. The
  // stored `sender_type` still records whether they spoke as the room's owner.
  return message.sender_type === 'core_prompter' ? 'core_prompter' : 'collaborator'
}

function ClaudeMark() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-500/20 text-indigo-200 ring-1 ring-indigo-400/30"
    >
      <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4">
        <path d="M8 1.5l1.5 4L13.5 7 9.5 8.5 8 12.5 6.5 8.5 2.5 7l4-1.5L8 1.5z" />
      </svg>
    </span>
  )
}

export function MessageBubble({ message, showHeader, isOwn, modelLabel }: MessageBubbleProps) {
  const { label, title } = useTimestamp(message.created_at)

  // A system row is the pipeline reporting a failed Claude turn to the whole
  // room at once, so it is a notice rather than a message and belongs to nobody.
  if (message.sender_type === 'system') {
    return (
      <div className="my-3 flex justify-center px-2">
        <p
          role="status"
          title={title}
          className="max-w-xl rounded-full border border-neutral-800 bg-neutral-900/70 px-3 py-1 text-center text-[11px] leading-4 text-neutral-500"
        >
          {message.original_content}
          <span className="ml-1.5 text-neutral-600">{label}</span>
        </p>
      </div>
    )
  }

  const isAssistant = message.sender_type === 'assistant'
  const role = roleOf(message)
  const isCore = isAssistant ? false : role === 'core_prompter'

  const pending = message.approval_status === 'pending'
  const rejected = message.approval_status === 'rejected'

  const name = isAssistant ? 'Claude' : (message.sender?.display_name ?? 'Former participant')
  // What the room reads is the collaborator's own words. An edit made during
  // approval changed what Claude was told, not what this person wrote, so the
  // original stays on screen and the edit is flagged instead.
  const body = message.original_content

  const container = isAssistant
    ? 'border-l-2 border-indigo-400/70 bg-indigo-500/[0.06]'
    : isCore
      ? 'border-l-2 border-amber-400/70 bg-amber-500/[0.05]'
      : 'border-l-2 border-transparent hover:bg-neutral-900/50'

  return (
    <div
      className={`group rounded-r-lg px-3 py-1.5 transition-colors ${container} ${
        pending ? 'opacity-60' : ''
      }`}
      data-own={isOwn || undefined}
    >
      <div className="flex gap-2.5">
        <div className="w-8 shrink-0">
          {showHeader ? (
            isAssistant ? (
              <ClaudeMark />
            ) : (
              <Avatar name={name} src={message.sender?.avatar_url ?? null} size="md" />
            )
          ) : (
            <span
              title={title}
              className="mt-0.5 block text-right text-[10px] leading-5 text-neutral-700 tabular-nums"
            >
              {message.created_at.slice(11, 16)}
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          {showHeader ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span
                className={`text-[13px] font-semibold ${
                  isAssistant ? 'text-indigo-200' : isCore ? 'text-amber-100' : 'text-neutral-100'
                }`}
              >
                {name}
                {isOwn && !isAssistant ? (
                  <span className="font-normal text-neutral-500"> (you)</span>
                ) : null}
              </span>

              {isAssistant ? (
                <span className="rounded border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-px text-[10px] font-medium text-indigo-300/90">
                  {modelLabel ?? DEFAULT_CLAUDE_MODEL_LABEL}
                </span>
              ) : isCore ? (
                <Badge tone="core">Core Prompter</Badge>
              ) : (
                <Badge tone="neutral">{ROLE_LABELS[role]}</Badge>
              )}

              <span title={title} className="text-[11px] text-neutral-600">
                {label}
              </span>

              {pending ? <Badge tone="neutral">Waiting for approval</Badge> : null}
              {rejected ? <Badge tone="neutral">Rejected</Badge> : null}
              {message.edited_content ? <Badge tone="neutral">Edited before sending</Badge> : null}
            </div>
          ) : null}

          {/*
           * Claude's reply is printed as a text node, never parsed as markup —
           * `prose-plain` restores the typography of plain text without letting
           * model output become HTML. It also drops the reading-width clamp the
           * human messages use, so code and tables get the full column.
           */}
          <p
            className={`mt-0.5 text-[13.5px] ${
              isAssistant ? 'prose-plain text-neutral-100' : 'prose-plain prose-measure'
            } ${
              rejected ? 'text-neutral-600 line-through' : isAssistant ? '' : 'text-neutral-200'
            }`}
          >
            {body}
          </p>

          {rejected && message.error ? (
            <p className="mt-1 text-[11px] leading-4 text-neutral-500">
              Reason: <span className="text-neutral-400">{message.error}</span>
            </p>
          ) : null}

          {!rejected && message.error ? (
            <p className="mt-1 text-[11px] leading-4 text-red-300/80">{message.error}</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export default MessageBubble
