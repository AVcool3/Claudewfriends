'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import Banner from '@/components/ui/Banner'
import Button from '@/components/ui/Button'
import { Field, TextInput } from '@/components/ui/Field'
import Modal from '@/components/ui/Modal'
import type { Capability } from '@/lib/permissions'
import { COLLABORATION_MODES, type CollaborationMode, type Room } from '@/lib/types'

export interface RoomSettingsProps {
  room: Room
  capabilities: Record<Capability, boolean>
}

/** The three room fields this panel can PATCH. */
type MutableSettings = Pick<Room, 'collaboration_mode' | 'is_locked' | 'allow_collaborator_messages'>

type BusyKey = 'mode' | 'messaging' | 'lock' | 'delete'

const MODE_SHORT: Record<CollaborationMode, string> = {
  open: 'Open',
  approval_required: 'Approval',
}

const MODE_TITLES: Record<CollaborationMode, string> = {
  open: 'Collaborator messages go straight to Claude.',
  approval_required: 'Collaborator messages queue for your approval before they reach Claude.',
}

const REASON_CORE_ONLY = 'Only the Core Prompter can change this.'
const REASON_LOCK = 'Only the Core Prompter or an administrator can lock this room.'
const REASON_DELETE = 'Only the Core Prompter can delete this room.'

async function readApiError(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => null)
  if (typeof payload === 'object' && payload !== null) {
    const { error } = payload as { error?: unknown }
    if (typeof error === 'string' && error.length > 0) return error
  }
  return `The change was refused (HTTP ${response.status}).`
}

export function RoomSettings({ room, capabilities }: RoomSettingsProps) {
  const router = useRouter()
  const messagingLabelId = useId()
  const confirmId = useId()

  const [draft, setDraft] = useState<Partial<MutableSettings>>({})
  const [busy, setBusy] = useState<BusyKey | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [roomId, setRoomId] = useState(room.id)

  // Switching rooms reuses this component instance. The optimistic draft (and
  // any error or half-typed delete confirmation) belongs to the previous room
  // and must never be shown against the new one.
  if (roomId !== room.id) {
    setRoomId(room.id)
    setDraft({})
    setError(null)
    setConfirmingDelete(false)
    setConfirmText('')
  }

  // The server value is authoritative; the draft only covers the window between
  // a successful PATCH and the router refresh that re-renders the sidebar.
  const view: MutableSettings = {
    collaboration_mode: draft.collaboration_mode ?? room.collaboration_mode,
    is_locked: draft.is_locked ?? room.is_locked,
    allow_collaborator_messages:
      draft.allow_collaborator_messages ?? room.allow_collaborator_messages,
  }

  function rollback(patch: Partial<MutableSettings>) {
    setDraft((current) => {
      const next = { ...current }
      for (const key of Object.keys(patch) as (keyof MutableSettings)[]) delete next[key]
      return next
    })
  }

  async function patchRoom(patch: Partial<MutableSettings>, key: BusyKey) {
    if (busy !== null) return
    setBusy(key)
    setError(null)
    setDraft((current) => ({ ...current, ...patch }))

    try {
      const response = await fetch(`/api/rooms/${room.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!response.ok) {
        setError(await readApiError(response))
        rollback(patch)
        return
      }
      router.refresh()
    } catch {
      setError('Network error. The setting was not changed.')
      rollback(patch)
    } finally {
      setBusy(null)
    }
  }

  async function deleteRoom() {
    if (busy !== null) return
    setBusy('delete')
    setError(null)

    try {
      const response = await fetch(`/api/rooms/${room.id}`, { method: 'DELETE' })
      if (!response.ok) {
        setError(await readApiError(response))
        return
      }
      setConfirmingDelete(false)
      router.push('/rooms')
      router.refresh()
    } catch {
      setError('Network error. The room was not deleted.')
    } finally {
      setBusy(null)
    }
  }

  const canMode = capabilities['room.change_mode']
  const canMessaging = capabilities['room.toggle_messaging']
  const canLock = capabilities['room.lock']
  const canDelete = capabilities['room.delete']
  const confirmed = confirmText.trim() === room.name

  return (
    <section
      aria-label={`Settings for ${room.name}`}
      className="scrollbar-thin max-h-72 shrink-0 overflow-y-auto border-t border-neutral-800 px-3 py-3"
    >
      <h2 className="text-[11px] font-semibold tracking-wide text-neutral-500 uppercase">
        Room settings
      </h2>

      {error ? (
        <div className="mt-2">
          <Banner tone="error" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        </div>
      ) : null}

      <div className="mt-2.5 flex flex-col gap-3">
        <div>
          <p className="mb-1 text-[11px] font-medium text-neutral-300">Collaboration mode</p>
          <div
            role="group"
            aria-label="Collaboration mode"
            className="grid grid-cols-2 gap-1 rounded-lg bg-neutral-950 p-1"
          >
            {COLLABORATION_MODES.map((candidate) => {
              const active = view.collaboration_mode === candidate
              return (
                <button
                  key={candidate}
                  type="button"
                  aria-pressed={active}
                  disabled={!canMode || busy !== null}
                  title={canMode ? MODE_TITLES[candidate] : REASON_CORE_ONLY}
                  onClick={() => patchRoom({ collaboration_mode: candidate }, 'mode')}
                  className={`rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/60 disabled:cursor-not-allowed disabled:opacity-50 ${
                    active
                      ? 'bg-neutral-800 text-neutral-100'
                      : 'text-neutral-500 hover:text-neutral-300'
                  }`}
                >
                  {MODE_SHORT[candidate]}
                </button>
              )
            })}
          </div>
          <p className="mt-1 text-[11px] leading-4 text-neutral-500">
            {MODE_TITLES[view.collaboration_mode]}
          </p>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span id={messagingLabelId} className="min-w-0 flex-1 text-[11px] text-neutral-300">
            Collaborators can send messages
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={view.allow_collaborator_messages}
            aria-labelledby={messagingLabelId}
            disabled={!canMessaging || busy !== null}
            title={
              canMessaging
                ? 'Pause contributions without locking the room.'
                : REASON_CORE_ONLY
            }
            onClick={() =>
              patchRoom({ allow_collaborator_messages: !view.allow_collaborator_messages }, 'messaging')
            }
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/60 disabled:cursor-not-allowed disabled:opacity-50 ${
              view.allow_collaborator_messages
                ? 'border-brand-500 bg-brand-500'
                : 'border-neutral-700 bg-neutral-800'
            }`}
          >
            <span
              aria-hidden="true"
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                view.allow_collaborator_messages ? 'translate-x-[18px]' : 'translate-x-[3px]'
              }`}
            />
          </button>
        </div>

        <div>
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            disabled={!canLock || busy !== null}
            loading={busy === 'lock'}
            title={canLock ? undefined : REASON_LOCK}
            onClick={() => patchRoom({ is_locked: !view.is_locked }, 'lock')}
          >
            {view.is_locked ? 'Unlock room' : 'Lock room'}
          </Button>
          <p className="mt-1 text-[11px] leading-4 text-neutral-500">
            {view.is_locked
              ? 'Locked: every contribution is frozen except the Core Prompter’s.'
              : 'Locking freezes every contribution except the Core Prompter’s.'}
          </p>
        </div>

        <div className="border-t border-neutral-800 pt-3">
          <Button
            variant="danger"
            size="sm"
            className="w-full"
            disabled={!canDelete || busy !== null}
            title={canDelete ? undefined : REASON_DELETE}
            onClick={() => {
              setConfirmText('')
              setError(null)
              setConfirmingDelete(true)
            }}
          >
            Delete room
          </Button>
        </div>
      </div>

      <Modal
        open={confirmingDelete}
        title={`Delete “${room.name}”?`}
        onClose={busy === 'delete' ? () => undefined : () => setConfirmingDelete(false)}
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy === 'delete'}
              onClick={() => setConfirmingDelete(false)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={busy === 'delete'}
              disabled={!confirmed}
              onClick={deleteRoom}
            >
              Delete room
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-[13px] leading-5 text-neutral-300">
            This removes the room, its membership list and the whole Claude conversation for everyone
            in it. It cannot be undone.
          </p>

          {error ? <Banner tone="error">{error}</Banner> : null}

          <Field
            label="Type the room name to confirm"
            htmlFor={confirmId}
            hint={room.name}
            error={confirmText.length > 0 && !confirmed ? 'That does not match the room name.' : undefined}
          >
            <TextInput
              id={confirmId}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={busy === 'delete'}
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
            />
          </Field>
        </div>
      </Modal>
    </section>
  )
}

export default RoomSettings
