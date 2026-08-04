'use client'

/**
 * The send box.
 *
 * It owns the optimistic write: the row is appended locally, POSTed, and either
 * confirmed by the response (and later by the realtime INSERT, which replaces it
 * by id) or removed with the server's own message shown. The draft is restored
 * on failure — losing someone's paragraph because a rate limit fired is worse
 * than any error copy.
 */

import { useEffect, useRef, useState } from 'react'

import Banner from '@/components/ui/Banner'
import Button from '@/components/ui/Button'
import { optimisticId } from '@/hooks/useRoomRealtime'
// `sanitize` is deliberately I/O-free so the browser can run the same
// normalisation the server will. Storing the normalised text on the optimistic
// row is what lets the realtime INSERT be matched to it by body.
import { assertMessageLength, normaliseMessage } from '@/lib/sanitize'
import { MAX_MESSAGE_LENGTH, type Message, type MessageWithSender, type Profile, type Role } from '@/lib/types'

export interface ComposerProps {
  roomId: string
  currentUser: Profile
  currentRole: Role
  /** Resolved from `capabilities['room.send_message']` on the server. */
  canSend: boolean
  /** The sentence from `denialReason()`, shown when `canSend` is false. */
  denialReason: string
  /** True when the room is `approval_required` and the sender is not the Core Prompter. */
  queues: boolean
  /** Fires only for turns that actually reach Claude, so a queued submit does not claim Claude is thinking. */
  onAwaitingClaude?: (awaiting: boolean) => void
  addOptimistic: (message: MessageWithSender) => void
  removeOptimistic: (id: string) => void
  onTyping?: () => void
}

/** Six rows of the 24px line box plus the textarea's vertical padding. */
const MAX_TEXTAREA_HEIGHT_PX = 6 * 24 + 16
const COUNTER_WARN_RATIO = 0.9

/** Surfaces the server's own sentence — a 429 or a lock has a reason worth reading. */
async function readApiError(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => null)
  if (typeof payload === 'object' && payload !== null) {
    const { error } = payload as { error?: unknown }
    if (typeof error === 'string' && error.length > 0) return error
  }
  return `Your message was not sent (HTTP ${response.status}).`
}

/** Narrows a row out of the pipeline's JSON response before it is rendered. */
function asMessage(value: unknown): Message | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Partial<Message>
  return typeof row.id === 'string' &&
    typeof row.room_id === 'string' &&
    typeof row.original_content === 'string' &&
    typeof row.created_at === 'string'
    ? (row as Message)
    : null
}

export function Composer({
  roomId,
  currentUser,
  currentRole,
  canSend,
  denialReason,
  queues,
  onAwaitingClaude,
  addOptimistic,
  removeOptimistic,
  onTyping,
}: ComposerProps) {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Code points, not UTF-16 units — the same measure `assertMessageLength` and
  // the Postgres check constraint use, so the counter never disagrees with the
  // rejection.
  const length = Array.from(draft).length
  const overLimit = length > MAX_MESSAGE_LENGTH
  const nearLimit = length >= MAX_MESSAGE_LENGTH * COUNTER_WARN_RATIO

  useEffect(() => {
    const element = textareaRef.current
    if (!element) return
    // Reset before measuring: scrollHeight only shrinks if the box is allowed to.
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`
    element.style.overflowY = element.scrollHeight > MAX_TEXTAREA_HEIGHT_PX ? 'auto' : 'hidden'
  }, [draft])

  const blocked = !canSend
  const canSubmit = !blocked && !sending && !overLimit && draft.trim().length > 0

  async function submit() {
    if (!canSubmit) return

    const content = normaliseMessage(draft)
    const lengthCheck = assertMessageLength(content)
    if (!lengthCheck.ok) {
      setError(lengthCheck.issues[0]?.message ?? 'That message cannot be sent.')
      return
    }

    const tempId = optimisticId()
    const optimistic: MessageWithSender = {
      id: tempId,
      room_id: roomId,
      sender_id: currentUser.id,
      sender_type: currentRole === 'core_prompter' ? 'core_prompter' : 'collaborator',
      original_content: content,
      processed_content: null,
      approval_status: queues ? 'pending' : 'sent',
      approved_by: null,
      approved_at: null,
      edited_content: null,
      error: null,
      created_at: new Date().toISOString(),
      sender: currentUser,
      sender_role: currentRole,
    }

    setError(null)
    setSending(true)
    setDraft('')
    addOptimistic(optimistic)
    if (!queues) onAwaitingClaude?.(true)

    try {
      const response = await fetch(`/api/rooms/${roomId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })

      if (!response.ok) {
        removeOptimistic(tempId)
        // Handed back so a rejected message is not simply lost.
        setDraft(draft)
        setError(await readApiError(response))
        return
      }

      const payload: unknown = await response.json()
      const result = (typeof payload === 'object' && payload !== null ? payload : {}) as {
        message?: unknown
        assistantMessage?: unknown
      }

      // The optimistic row is swapped for the real one here rather than waiting
      // on realtime: if the socket is slow or down, the sender still sees their
      // message settle. Both rows carry the server's id, so the INSERT that
      // arrives later replaces this one instead of duplicating it.
      removeOptimistic(tempId)
      const stored = asMessage(result.message)
      if (stored) {
        addOptimistic({ ...stored, sender: currentUser, sender_role: currentRole })
      }
      const assistant = asMessage(result.assistantMessage)
      if (assistant) {
        addOptimistic({ ...assistant, sender: null, sender_role: null })
      }
    } catch {
      removeOptimistic(tempId)
      setDraft(draft)
      setError('Network error. Your message was not sent.')
    } finally {
      setSending(false)
      onAwaitingClaude?.(false)
      textareaRef.current?.focus()
    }
  }

  return (
    <div className="shrink-0 border-t border-neutral-800 bg-neutral-900 px-4 py-3">
      {error ? (
        <div className="mb-2">
          <Banner tone="error" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        </div>
      ) : null}

      {blocked ? (
        <div className="flex items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-950/60 px-3 py-3">
          <p className="text-[13px] leading-5 text-neutral-400">{denialReason}</p>
        </div>
      ) : (
        <>
          <div className="flex items-end gap-2">
            {/*
             * A plain textarea rather than the Field primitive: this one is
             * script-resized every keystroke and must never show a drag handle,
             * and a `resize-none` passed through className would be fighting the
             * primitive's own `resize-y` in the stylesheet rather than reliably
             * overriding it. The colours below mirror it exactly.
             */}
            <textarea
              ref={textareaRef}
              rows={1}
              value={draft}
              aria-label="Message"
              aria-invalid={overLimit || undefined}
              placeholder={
                queues ? 'Write a contribution for the Core Prompter to approve…' : 'Message Claude…'
              }
              disabled={sending}
              onChange={(event) => {
                setDraft(event.target.value)
                onTyping?.()
              }}
              onKeyDown={(event) => {
                // Shift+Enter is a newline. `isComposing` keeps an IME's
                // confirmation Enter from firing the send.
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
                event.preventDefault()
                void submit()
              }}
              className="scrollbar-thin max-h-40 w-full resize-none rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm leading-6 text-neutral-100 transition-colors placeholder:text-neutral-500 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-red-700"
            />

            <Button
              onClick={() => void submit()}
              loading={sending}
              disabled={!canSubmit}
              className="shrink-0"
            >
              {queues ? 'Submit for approval' : 'Send'}
            </Button>
          </div>

          <div className="mt-1.5 flex items-start gap-3">
            <p className="min-w-0 flex-1 text-[11px] leading-4 text-neutral-500">
              {queues
                ? 'This contribution queues for the Core Prompter — it reaches Claude only once they approve it.'
                : 'Enter to send, Shift+Enter for a new line.'}
            </p>
            <span
              aria-live="polite"
              className={`shrink-0 text-[11px] tabular-nums ${
                overLimit ? 'text-red-300' : nearLimit ? 'text-amber-300' : 'text-neutral-600'
              }`}
            >
              {/* Plain digits, not `toLocaleString()`: the grouping separator
                  follows the renderer's locale, which differs between the
                  server and the browser and would trip hydration. */}
              {length} / {MAX_MESSAGE_LENGTH}
            </span>
          </div>
        </>
      )}
    </div>
  )
}

export default Composer
