'use client'

import { useEffect, useId, useState, type FormEvent } from 'react'
import Banner from '@/components/ui/Banner'
import Button from '@/components/ui/Button'
import { Field, Select, TextInput } from '@/components/ui/Field'
import Modal from '@/components/ui/Modal'
import { ASSIGNABLE_ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, type Role } from '@/lib/types'

export interface InviteDialogProps {
  open: boolean
  roomId: string
  onClose: () => void
  /** Fired after a successful invite so the panel can pull the pending list again. */
  onInvited?: () => void
}

async function readApiError(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => null)
  if (typeof payload === 'object' && payload !== null) {
    const { error } = payload as { error?: unknown }
    if (typeof error === 'string' && error.length > 0) return error
  }
  return `The invitation was refused (HTTP ${response.status}).`
}

/** The route may return the URL at the top level or nested on the invitation. */
function readInviteUrl(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const body = payload as { invite_url?: unknown; invitation?: { invite_url?: unknown } | null }
  if (typeof body.invite_url === 'string' && body.invite_url.length > 0) return body.invite_url
  if (body.invitation && typeof body.invitation.invite_url === 'string') {
    return body.invitation.invite_url
  }
  return null
}

export function InviteDialog({ open, roomId, onClose, onInvited }: InviteDialogProps) {
  const formId = useId()
  const emailId = useId()
  const roleId = useId()
  const linkId = useId()

  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('collaborator')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [invitedEmail, setInvitedEmail] = useState('')
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)

  // Reopening must not show the previous invitation's link — that link is a
  // bearer token and leaving it on screen invites it being sent to the wrong
  // person.
  useEffect(() => {
    if (!open) return
    setEmail('')
    setRole('collaborator')
    setBusy(false)
    setError(null)
    setInviteUrl(null)
    setInvitedEmail('')
    setCopied(false)
    setCopyError(null)
  }, [open])

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return

    // Supabase stores addresses lower-cased and the invitation is matched
    // against the redeeming account's address, so normalise before sending.
    const address = email.trim().toLowerCase()
    if (!address.includes('@') || address.length < 3) {
      setError('Enter a valid email address.')
      return
    }

    setBusy(true)
    setError(null)

    try {
      const response = await fetch(`/api/rooms/${roomId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: address, role }),
      })

      if (!response.ok) {
        setError(await readApiError(response))
        return
      }

      const url = readInviteUrl(await response.json().catch(() => null))
      setInvitedEmail(address)
      if (!url) {
        setError('The invitation was created but no link came back. Reload the panel to check.')
        return
      }
      setInviteUrl(url)
      onInvited?.()
    } catch {
      setError('Network error while creating the invitation. Try again.')
    } finally {
      setBusy(false)
    }
  }

  async function copyLink() {
    if (!inviteUrl) return
    setCopyError(null)
    try {
      // Absent outside a secure context, so this is a feature test rather than
      // an optional-chain flourish.
      if (!navigator.clipboard) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(inviteUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopyError('Could not reach the clipboard — select the link and copy it manually.')
    }
  }

  const done = inviteUrl !== null

  return (
    <Modal
      open={open}
      title={done ? 'Invitation created' : 'Invite someone to this room'}
      onClose={busy ? () => undefined : onClose}
      footer={
        done ? (
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" form={formId} size="sm" loading={busy}>
              Create invitation
            </Button>
          </>
        )
      }
    >
      {done && inviteUrl ? (
        <div className="flex flex-col gap-3">
          <Banner tone="success" title={`Invitation ready for ${invitedEmail}`}>
            Send this link to them yourself — the app does not email it.
          </Banner>

          <Field label="Invitation link" htmlFor={linkId}>
            <div className="flex items-center gap-2">
              <TextInput
                id={linkId}
                readOnly
                value={inviteUrl}
                onFocus={(event) => event.currentTarget.select()}
                className="font-mono"
              />
              <Button variant="secondary" size="sm" onClick={copyLink} className="shrink-0">
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </Field>

          {copyError ? <Banner tone="warning">{copyError}</Banner> : null}

          <ul className="flex list-disc flex-col gap-1 pl-4 text-[11px] leading-4 text-neutral-500">
            <li>It expires in 7 days.</li>
            <li>
              It can only be redeemed by <span className="text-neutral-300">{invitedEmail}</span> —
              forwarding it to anyone else does not let them in.
            </li>
            <li>They join as {ROLE_LABELS[role]} once they accept.</li>
          </ul>
        </div>
      ) : (
        <form id={formId} onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {error ? (
            <Banner tone="error" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          ) : null}

          <Field
            label="Email address"
            htmlFor={emailId}
            hint="The invitation only works for this exact address."
          >
            <TextInput
              id={emailId}
              type="email"
              name="email"
              autoFocus
              required
              autoComplete="off"
              inputMode="email"
              disabled={busy}
              placeholder="teammate@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>

          <Field label="Role" htmlFor={roleId} hint={ROLE_DESCRIPTIONS[role]}>
            <Select
              id={roleId}
              name="role"
              disabled={busy}
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
            >
              {ASSIGNABLE_ROLES.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {ROLE_LABELS[candidate]}
                </option>
              ))}
            </Select>
          </Field>

          <p className="text-[11px] leading-4 text-neutral-500">
            The Core Prompter role is not assignable — it stays with whoever created the room.
          </p>
        </form>
      )}
    </Modal>
  )
}

export default InviteDialog
