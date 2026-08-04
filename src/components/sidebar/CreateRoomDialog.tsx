'use client'

import { useEffect, useId, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import Banner from '@/components/ui/Banner'
import Button from '@/components/ui/Button'
import { Field, Select, TextInput } from '@/components/ui/Field'
import Modal from '@/components/ui/Modal'
import {
  COLLABORATION_MODES,
  MAX_ROOM_NAME_LENGTH,
  type CollaborationMode,
} from '@/lib/types'

export interface CreateRoomDialogProps {
  open: boolean
  onClose: () => void
}

const MODE_LABELS: Record<CollaborationMode, string> = {
  open: 'Open collaboration',
  approval_required: 'Approval required',
}

const MODE_EXPLANATIONS: Record<CollaborationMode, string> = {
  open: 'Every collaborator message is sent to Claude as soon as it is written.',
  approval_required: 'Collaborator messages queue for the Core Prompter to approve, edit or reject.',
}

/** Prefers the server's own wording so a 403 explains *why* it was refused. */
async function readApiError(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => null)
  if (typeof payload === 'object' && payload !== null) {
    const { error } = payload as { error?: unknown }
    if (typeof error === 'string' && error.length > 0) return error
  }
  return `Could not create the room (HTTP ${response.status}).`
}

/**
 * The route's success body is not pinned by the contract, so accept the two
 * shapes it could reasonably take rather than guessing one and breaking.
 */
function readRoomId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const body = payload as { id?: unknown; room?: { id?: unknown } | null }
  if (typeof body.id === 'string' && body.id.length > 0) return body.id
  if (body.room && typeof body.room.id === 'string' && body.room.id.length > 0) return body.room.id
  return null
}

export function CreateRoomDialog({ open, onClose }: CreateRoomDialogProps) {
  const router = useRouter()
  const formId = useId()
  const nameId = useId()
  const modeId = useId()

  const [name, setName] = useState('')
  const [mode, setMode] = useState<CollaborationMode>('open')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The dialog instance outlives a single use, so reopening it must not show
  // the previous attempt's half-typed name or its error.
  useEffect(() => {
    if (!open) return
    setName('')
    setMode('open')
    setError(null)
    setBusy(false)
  }, [open])

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return

    const trimmed = name.trim()
    if (trimmed.length === 0) {
      setError('Give the room a name.')
      return
    }

    setBusy(true)
    setError(null)

    try {
      const response = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, collaboration_mode: mode }),
      })

      if (!response.ok) {
        setError(await readApiError(response))
        return
      }

      const roomId = readRoomId(await response.json().catch(() => null))
      if (!roomId) {
        setError('The room was created but the server did not return its id. Reload to find it.')
        return
      }

      onClose()
      router.push(`/rooms/${roomId}`)
      // The sidebar is server-rendered in the rooms layout; without this the new
      // room would not appear in the list until a full navigation.
      router.refresh()
    } catch {
      setError('Network error while creating the room. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title="New room"
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} size="sm" loading={busy}>
            Create room
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {error ? (
          <Banner tone="error" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        ) : null}

        <Field
          label="Room name"
          htmlFor={nameId}
          hint={`Up to ${MAX_ROOM_NAME_LENGTH} characters. Everyone you invite sees it.`}
        >
          <TextInput
            id={nameId}
            name="name"
            autoFocus
            required
            disabled={busy}
            maxLength={MAX_ROOM_NAME_LENGTH}
            placeholder="Launch planning"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field label="Collaboration mode" htmlFor={modeId}>
          <Select
            id={modeId}
            name="collaboration_mode"
            disabled={busy}
            value={mode}
            onChange={(event) => setMode(event.target.value as CollaborationMode)}
          >
            {COLLABORATION_MODES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {MODE_LABELS[candidate]}
              </option>
            ))}
          </Select>
        </Field>

        <dl className="flex flex-col gap-2 rounded-lg border border-neutral-800 bg-neutral-950/60 px-3 py-2.5">
          {COLLABORATION_MODES.map((candidate) => (
            <div key={candidate}>
              <dt
                className={`text-[11px] font-medium ${
                  candidate === mode ? 'text-neutral-200' : 'text-neutral-500'
                }`}
              >
                {MODE_LABELS[candidate]}
              </dt>
              <dd
                className={`text-[11px] leading-4 ${
                  candidate === mode ? 'text-neutral-400' : 'text-neutral-600'
                }`}
              >
                {MODE_EXPLANATIONS[candidate]}
              </dd>
            </div>
          ))}
        </dl>

        <p className="text-[11px] leading-4 text-neutral-500">
          You become the room&apos;s Core Prompter: every contribution reaches Claude attributed to
          you, and you can change the mode later.
        </p>
      </form>
    </Modal>
  )
}

export default CreateRoomDialog
