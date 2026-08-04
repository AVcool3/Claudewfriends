'use client'

/**
 * The scrolling transcript.
 *
 * Two behaviours here are about not stealing the reader's place: new messages
 * only pull the view down when the reader was already at the bottom, and a
 * pending contribution is hidden from members who are not entitled to see it,
 * so the queue never leaks half-approved text into the shared record.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import MessageBubble from '@/components/chat/MessageBubble'
import Spinner from '@/components/ui/Spinner'
import type { MessageWithSender } from '@/lib/types'

export interface MessageListProps {
  messages: MessageWithSender[]
  currentUserId: string
  /** True for the Core Prompter, who reviews every queued contribution. */
  canSeePending: boolean
  /** Renders the "Claude is thinking…" row at the end of the transcript. */
  claudeThinking?: boolean
  modelLabel?: string | null
}

/** How close to the bottom still counts as "following the conversation". */
const NEAR_BOTTOM_PX = 120
/** Messages from one sender inside this window share a header. */
const GROUP_WINDOW_MS = 5 * 60 * 1000

type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'message'; key: string; message: MessageWithSender; showHeader: boolean }

/**
 * The day key drives both the separators and the grouping, so it has to be
 * identical on the server and in the browser for the first render — the server
 * has no idea what timezone the reader is in. `localised` starts false, giving
 * both sides the UTC date, and flips after hydration so the separators end up
 * showing the reader's own days.
 */
function dayKeyOf(iso: string, localised: boolean): string {
  if (!localised) return iso.slice(0, 10)
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function dayLabelOf(iso: string, key: string, localised: boolean): string {
  if (!localised) return key
  const today = dayKeyOf(new Date().toISOString(), true)
  if (key === today) return 'Today'
  const yesterday = dayKeyOf(new Date(Date.now() - 86_400_000).toISOString(), true)
  if (key === yesterday) return 'Yesterday'
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function continuesGroup(previous: MessageWithSender, current: MessageWithSender): boolean {
  // A system notice is never part of a run, and Claude's turns are grouped by
  // sender_type because they carry no sender id at all.
  if (previous.sender_type === 'system' || current.sender_type === 'system') return false
  if (previous.sender_type !== current.sender_type) return false
  if (previous.sender_id !== current.sender_id) return false
  const gap = Date.parse(current.created_at) - Date.parse(previous.created_at)
  return Number.isFinite(gap) && gap >= 0 && gap < GROUP_WINDOW_MS
}

export function MessageList({
  messages,
  currentUserId,
  canSeePending,
  claudeThinking = false,
  modelLabel,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  // Read inside effects that must not re-run when the value changes, so it is a
  // ref rather than state; `showJump` is the rendered mirror of it.
  const nearBottomRef = useRef(true)
  const didMountRef = useRef(false)

  const [showJump, setShowJump] = useState(false)
  const [missedMessages, setMissedMessages] = useState(false)
  const [localised, setLocalised] = useState(false)

  useEffect(() => {
    setLocalised(true)
  }, [])

  /**
   * A queued contribution is visible to its author and to the Core Prompter who
   * has to act on it. Everyone else sees nothing at all — showing a greyed-out
   * placeholder would publish text the room has not accepted.
   */
  const visible = useMemo(
    () =>
      messages.filter((message) => {
        if (message.approval_status !== 'pending' && message.approval_status !== 'rejected') {
          return true
        }
        return canSeePending || message.sender_id === currentUserId
      }),
    [messages, canSeePending, currentUserId],
  )

  const rows = useMemo<Row[]>(() => {
    const output: Row[] = []
    let previousDay: string | null = null
    let previous: MessageWithSender | null = null

    for (const message of visible) {
      const key = dayKeyOf(message.created_at, localised)
      if (key !== previousDay) {
        output.push({ kind: 'day', key: `day-${key}`, label: dayLabelOf(message.created_at, key, localised) })
        previousDay = key
        previous = null
      }
      const showHeader = previous === null || !continuesGroup(previous, message)
      output.push({ kind: 'message', key: message.id, message, showHeader })
      previous = message
    }

    return output
  }, [visible, localised])

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    bottomRef.current?.scrollIntoView({ behavior, block: 'end' })
    nearBottomRef.current = true
    setShowJump(false)
    setMissedMessages(false)
  }, [])

  const handleScroll = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    const near = distance <= NEAR_BOTTOM_PX
    nearBottomRef.current = near
    setShowJump((prev) => (prev === !near ? prev : !near))
    if (near) setMissedMessages(false)
  }, [])

  const lastKey = visible.length > 0 ? visible[visible.length - 1].id : null

  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true
      // Opening a room lands at the newest message, and jumping there without
      // an animation avoids scrolling the whole history past the reader.
      scrollToBottom('auto')
      return
    }
    if (nearBottomRef.current) {
      scrollToBottom('smooth')
      return
    }
    setMissedMessages(true)
  }, [lastKey, claudeThinking, scrollToBottom])

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-label="Conversation"
        className="scrollbar-thin h-full overflow-y-auto px-3 py-4"
      >
        {rows.length === 0 ? (
          <p className="mt-10 text-center text-[13px] text-neutral-600">
            No messages yet. The first contribution starts the conversation with Claude.
          </p>
        ) : null}

        {rows.map((row) =>
          row.kind === 'day' ? (
            <div key={row.key} className="my-4 flex items-center gap-3 px-3">
              <span className="h-px flex-1 bg-neutral-800" />
              <span className="text-[11px] font-medium text-neutral-600">{row.label}</span>
              <span className="h-px flex-1 bg-neutral-800" />
            </div>
          ) : (
            <MessageBubble
              key={row.key}
              message={row.message}
              showHeader={row.showHeader}
              isOwn={row.message.sender_id === currentUserId}
              modelLabel={modelLabel}
            />
          ),
        )}

        {claudeThinking ? (
          <div className="flex items-center gap-2.5 px-3 py-2 text-[13px] text-indigo-200/80">
            <span className="w-8 shrink-0" />
            <Spinner size="sm" label="Claude is generating a reply" />
            <span>Claude is thinking…</span>
          </div>
        ) : null}

        <div ref={bottomRef} />
      </div>

      {showJump ? (
        <button
          type="button"
          onClick={() => scrollToBottom('smooth')}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-neutral-700 bg-neutral-800/95 px-3 py-1.5 text-[11px] font-medium text-neutral-100 shadow-lg backdrop-blur transition-colors hover:bg-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/60"
        >
          {missedMessages ? 'New messages · Jump to latest' : 'Jump to latest'}
        </button>
      ) : null}
    </div>
  )
}

export default MessageList
