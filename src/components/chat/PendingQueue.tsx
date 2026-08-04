'use client'

/**
 * The Core Prompter's approval desk.
 *
 * In `approval_required` mode nothing a collaborator writes reaches Claude until
 * it passes through here, so this panel is the room's gate rather than a
 * notification list: it is always expanded, every action is one click from the
 * text it applies to, and combining several contributions into a single turn is
 * a first-class action rather than something to be done by copy-paste.
 *
 * Only the Core Prompter is given this component — `room.approve_message`
 * resolves to them alone, and the same check runs again server-side.
 */

import { useMemo, useState } from 'react'

import Avatar from '@/components/ui/Avatar'
import Badge from '@/components/ui/Badge'
import Banner from '@/components/ui/Banner'
import Button from '@/components/ui/Button'
import { Textarea } from '@/components/ui/Field'
import { MAX_MESSAGE_LENGTH, type MessageWithSender } from '@/lib/types'

export interface PendingQueueProps {
  roomId: string
  /** Contributions with `approval_status === 'pending'`, oldest first. */
  pending: MessageWithSender[]
  /** Fires around requests that put a turn in front of Claude. */
  onAwaitingClaude?: (awaiting: boolean) => void
}

type Mode = { kind: 'edit'; id: string } | { kind: 'reject'; id: string } | null

/** Surfaces the server's own sentence — a stale queue returns a specific 409. */
async function readApiError(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => null)
  if (typeof payload === 'object' && payload !== null) {
    const { error } = payload as { error?: unknown }
    if (typeof error === 'string' && error.length > 0) return error
  }
  return `That action was refused (HTTP ${response.status}).`
}

export function PendingQueue({ roomId, pending, onAwaitingClaude }: PendingQueueProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>(null)
  const [draft, setDraft] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [combineNote, setCombineNote] = useState('')

  // Derived rather than pruned in an effect: a contribution that was approved by
  // another tab simply drops out of `pending`, and its stale id in `selected`
  // must not be posted to the combine endpoint.
  const selection = useMemo(() => {
    const ids = new Set(pending.map((message) => message.id))
    return selected.filter((id) => ids.has(id))
  }, [selected, pending])

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]))
  }

  function reset() {
    setMode(null)
    setDraft('')
  }

  async function post(
    label: string,
    url: string,
    body: unknown,
    reachesClaude: boolean,
  ): Promise<boolean> {
    if (busy !== null) return false
    setBusy(label)
    setError(null)
    if (reachesClaude) onAwaitingClaude?.(true)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        setError(await readApiError(response))
        return false
      }
      // The row's UPDATE arrives over realtime and drops it out of `pending`,
      // which also drops it out of `selection`, so there is no local list to
      // reconcile here.
      reset()
      return true
    } catch {
      setError('Network error. Nothing was sent to Claude.')
      return false
    } finally {
      setBusy(null)
      if (reachesClaude) onAwaitingClaude?.(false)
    }
  }

  function approve(id: string, content?: string) {
    void post(
      `approve:${id}`,
      `/api/rooms/${roomId}/messages/${id}/approve`,
      content === undefined ? {} : { content },
      true,
    )
  }

  function reject(id: string, reason: string) {
    void post(
      `reject:${id}`,
      `/api/rooms/${roomId}/messages/${id}/reject`,
      reason.trim().length > 0 ? { reason: reason.trim() } : {},
      false,
    )
  }

  async function combine() {
    if (selection.length === 0) return
    const sent = await post(
      'combine',
      `/api/rooms/${roomId}/messages/combine`,
      combineNote.trim().length > 0
        ? { messageIds: selection, content: combineNote.trim() }
        : { messageIds: selection },
      true,
    )
    // Kept on a failure so the Core Prompter can retry the same batch without
    // re-ticking every box.
    if (sent) {
      setSelected([])
      setCombineNote('')
    }
  }

  if (pending.length === 0) return null

  return (
    <section
      aria-label="Contributions waiting for approval"
      className="shrink-0 border-b border-amber-900/40 bg-amber-950/20"
    >
      <header className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-2">
        <h2 className="text-[13px] font-semibold text-amber-100">Waiting for your approval</h2>
        <Badge tone="core">{pending.length}</Badge>
        <span className="min-w-0 flex-1" />
        {selection.length > 0 ? (
          <Button size="sm" variant="ghost" onClick={() => setSelected([])} disabled={busy !== null}>
            Clear selection
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          disabled={busy !== null || pending.length < 2}
          title={pending.length < 2 ? 'Select two or more contributions to combine.' : undefined}
          onClick={() => setSelected(pending.map((message) => message.id))}
        >
          Select all
        </Button>
      </header>

      {error ? (
        <div className="px-4 pb-2">
          <Banner tone="error" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        </div>
      ) : null}

      <ul className="scrollbar-thin max-h-72 space-y-1.5 overflow-y-auto px-3 pb-2">
        {pending.map((message) => {
          const name = message.sender?.display_name ?? 'Former participant'
          const editing = mode?.kind === 'edit' && mode.id === message.id
          const rejecting = mode?.kind === 'reject' && mode.id === message.id
          const rowBusy = busy?.endsWith(`:${message.id}`) === true
          const checked = selection.includes(message.id)

          return (
            <li
              key={message.id}
              className={`rounded-lg border px-3 py-2.5 transition-colors ${
                checked ? 'border-amber-500/50 bg-amber-500/10' : 'border-neutral-800 bg-neutral-950/50'
              }`}
            >
              <div className="flex items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={busy !== null}
                  aria-label={`Select the contribution from ${name} to combine`}
                  onChange={() => toggle(message.id)}
                  className="mt-1 h-3.5 w-3.5 shrink-0 accent-amber-500"
                />
                <Avatar name={name} src={message.sender?.avatar_url ?? null} size="sm" />

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-xs font-medium text-neutral-100">{name}</span>
                    <span
                      title={message.created_at}
                      className="text-[11px] text-neutral-600 tabular-nums"
                    >
                      {message.created_at.slice(11, 16)}
                    </span>
                    {message.edited_content ? <Badge tone="neutral">Edited</Badge> : null}
                  </div>

                  {editing ? (
                    <div className="mt-2 flex flex-col gap-2">
                      <Textarea
                        rows={4}
                        value={draft}
                        maxLength={MAX_MESSAGE_LENGTH}
                        aria-label={`Edit the contribution from ${name}`}
                        onChange={(event) => setDraft(event.target.value)}
                      />
                      <p className="text-[11px] leading-4 text-neutral-500">
                        The room keeps seeing what {name} wrote — only the text handed to Claude
                        changes, and it is labelled as edited.
                      </p>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          loading={rowBusy}
                          disabled={draft.trim().length === 0}
                          onClick={() => approve(message.id, draft)}
                        >
                          Approve edited
                        </Button>
                        <Button size="sm" variant="ghost" disabled={rowBusy} onClick={reset}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="prose-plain-compact mt-1 text-neutral-300">
                      {message.original_content}
                    </p>
                  )}

                  {rejecting ? (
                    <div className="mt-2 flex flex-col gap-2">
                      <Textarea
                        rows={2}
                        value={draft}
                        maxLength={500}
                        placeholder="Reason (optional) — shown to the author on their message"
                        aria-label={`Reason for rejecting the contribution from ${name}`}
                        onChange={(event) => setDraft(event.target.value)}
                      />
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="danger"
                          loading={rowBusy}
                          onClick={() => reject(message.id, draft)}
                        >
                          Confirm reject
                        </Button>
                        <Button size="sm" variant="ghost" disabled={rowBusy} onClick={reset}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {!editing && !rejecting ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Button
                        size="sm"
                        loading={rowBusy && busy === `approve:${message.id}`}
                        disabled={busy !== null}
                        onClick={() => approve(message.id)}
                      >
                        Approve &amp; send
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy !== null}
                        onClick={() => {
                          setDraft(message.edited_content ?? message.original_content)
                          setMode({ kind: 'edit', id: message.id })
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => {
                          setDraft('')
                          setMode({ kind: 'reject', id: message.id })
                        }}
                      >
                        Reject
                      </Button>
                    </div>
                  ) : null}
                </div>
              </div>
            </li>
          )
        })}
      </ul>

      {selection.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-amber-900/30 px-4 py-2.5">
          <Textarea
            rows={2}
            value={combineNote}
            maxLength={MAX_MESSAGE_LENGTH}
            placeholder="Optional note from you, sent alongside the selected contributions…"
            aria-label="Note to send with the combined contributions"
            onChange={(event) => setCombineNote(event.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              loading={busy === 'combine'}
              disabled={busy !== null}
              onClick={() => void combine()}
            >
              Combine selected &amp; send ({selection.length})
            </Button>
            <p className="min-w-0 flex-1 text-[11px] leading-4 text-neutral-500">
              Each contribution keeps its own author label, so one turn never merges two people&apos;s
              identities.
            </p>
          </div>
        </div>
      ) : null}
    </section>
  )
}

export default PendingQueue
