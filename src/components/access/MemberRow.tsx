'use client'

import { useState } from 'react'
import Badge, { type BadgeTone } from '@/components/ui/Badge'
import Banner from '@/components/ui/Banner'
import Avatar from '@/components/ui/Avatar'
import Button from '@/components/ui/Button'
import { Select } from '@/components/ui/Field'
import Modal from '@/components/ui/Modal'
import Spinner from '@/components/ui/Spinner'
import { ASSIGNABLE_ROLES, ROLE_LABELS, type Role, type RoomMemberWithProfile } from '@/lib/types'

/** Shared with AccessPanel, which renders the same tones for invitation rows. */
export const ROLE_TONE: Record<Role, BadgeTone> = {
  core_prompter: 'core',
  administrator: 'admin',
  collaborator: 'collab',
  viewer: 'viewer',
}

/** The result of a permission check, carrying the sentence explaining a denial. */
export interface PermissionVerdict {
  allowed: boolean
  reason?: string
}

export interface MemberRowProps {
  roomId: string
  member: RoomMemberWithProfile
  isSelf: boolean
  /** True for the room's owner. Their role is structural and cannot be edited. */
  isCorePrompter: boolean
  roleChange: PermissionVerdict
  removal: PermissionVerdict
  onChanged?: () => void
}

type Busy = 'role' | 'remove' | null

/**
 * Surfaces the server's own message. A 403 from the members API carries the
 * specific reason (an administrator cannot demote another administrator, the
 * Core Prompter cannot be removed, …); replacing it with "Request failed" would
 * throw away the only useful part of the response.
 */
async function readApiError(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => null)
  if (typeof payload === 'object' && payload !== null) {
    const { error } = payload as { error?: unknown }
    if (typeof error === 'string' && error.length > 0) return error
  }
  return `The change was refused (HTTP ${response.status}).`
}

function TrashIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      className="h-3.5 w-3.5 shrink-0"
    >
      <path d="M2.75 4.25h10.5" />
      <path d="M6.25 4.25V3a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 .75.75v1.25" />
      <path d="M4.25 4.25 4.9 13a.75.75 0 0 0 .75.7h4.7a.75.75 0 0 0 .75-.7l.65-8.75" />
    </svg>
  )
}

export function MemberRow({
  roomId,
  member,
  isSelf,
  isCorePrompter,
  roleChange,
  removal,
  onChanged,
}: MemberRowProps) {
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [ban, setBan] = useState(false)
  const [pendingRole, setPendingRole] = useState<Role | null>(null)

  const name = member.profile?.display_name ?? 'Unknown member'
  const email = member.profile?.email ?? '—'

  // Once the refreshed props catch up with the optimistic value the override has
  // done its job; dropping it lets a change made by someone else show through.
  if (pendingRole !== null && pendingRole === member.role) setPendingRole(null)

  async function changeRole(nextRole: Role) {
    if (busy !== null || nextRole === member.role) return
    setBusy('role')
    setError(null)
    setPendingRole(nextRole)

    try {
      const response = await fetch(`/api/rooms/${roomId}/members/${member.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: nextRole }),
      })
      if (!response.ok) {
        setError(await readApiError(response))
        setPendingRole(null)
        return
      }
      onChanged?.()
    } catch {
      setError('Network error. The role was not changed.')
      setPendingRole(null)
    } finally {
      setBusy(null)
    }
  }

  async function remove() {
    if (busy !== null) return
    setBusy('remove')
    setError(null)

    try {
      const response = await fetch(
        `/api/rooms/${roomId}/members/${member.id}${ban ? '?ban=1' : ''}`,
        { method: 'DELETE' },
      )
      if (!response.ok) {
        setError(await readApiError(response))
        return
      }
      setConfirming(false)
      setBan(false)
      onChanged?.()
    } catch {
      setError('Network error. The member was not removed.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <li className="rounded-lg border border-transparent px-2 py-2 transition-colors hover:border-neutral-800 hover:bg-neutral-800/40">
      <div className="flex items-start gap-2.5">
        <Avatar name={name} src={member.profile?.avatar_url ?? null} size="md" />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-xs font-medium text-neutral-100">
              {name}
              {isSelf ? <span className="font-normal text-neutral-500"> (you)</span> : null}
            </span>
            <span
              className="inline-flex shrink-0 items-center"
              title={member.is_online ? 'Online' : 'Offline'}
            >
              <span
                aria-hidden="true"
                className={`h-2 w-2 rounded-full ${
                  member.is_online ? 'bg-emerald-400' : 'bg-neutral-600'
                }`}
              />
              <span className="sr-only">
                {member.is_online ? `${name} is online` : `${name} is offline`}
              </span>
            </span>
          </div>

          <p className="truncate text-[11px] leading-4 text-neutral-500" title={email}>
            {email}
          </p>

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={isCorePrompter ? 'core' : ROLE_TONE[pendingRole ?? member.role]}>
              {isCorePrompter ? 'Core Prompter' : ROLE_LABELS[pendingRole ?? member.role]}
            </Badge>
            {member.status === 'invited' ? <Badge tone="neutral">Invitation pending</Badge> : null}
            {busy !== null ? <Spinner size="sm" label="Saving" /> : null}
          </div>

          {/*
           * The Core Prompter's controls are omitted rather than disabled: the
           * role cannot be reassigned and the owner cannot be removed from their
           * own room under any permission, so a greyed-out control would imply a
           * state that does not exist.
           */}
          {isCorePrompter ? null : (
            <div className="mt-2 flex items-center gap-1.5">
              <Select
                aria-label={`Role for ${name}`}
                className="min-w-0 flex-1"
                value={pendingRole ?? member.role}
                disabled={!roleChange.allowed || busy !== null}
                title={roleChange.allowed ? undefined : roleChange.reason}
                onChange={(event) => changeRole(event.target.value as Role)}
              >
                {ASSIGNABLE_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABELS[role]}
                  </option>
                ))}
              </Select>

              {/*
               * Not the Button primitive: its sizes carry horizontal padding
               * sized for a text label, which would crush a 14px glyph inside a
               * square icon button. The colours below match `secondary`.
               */}
              <button
                type="button"
                aria-label={`Remove ${name} from this room`}
                title={removal.allowed ? `Remove ${name}` : removal.reason}
                disabled={!removal.allowed || busy !== null}
                onClick={() => {
                  setBan(false)
                  setError(null)
                  setConfirming(true)
                }}
                className="inline-flex h-10 w-9 shrink-0 items-center justify-center rounded-lg border border-neutral-700 bg-neutral-800 text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/60 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <TrashIcon />
              </button>
            </div>
          )}
        </div>
      </div>

      {!confirming && error ? (
        <p role="alert" className="mt-1.5 text-[11px] leading-4 text-red-300">
          {error}
        </p>
      ) : null}

      <Modal
        open={confirming}
        title={`Remove ${name}?`}
        onClose={busy === 'remove' ? () => undefined : () => setConfirming(false)}
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy === 'remove'}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
            <Button variant="danger" size="sm" loading={busy === 'remove'} onClick={remove}>
              {ban ? 'Remove and ban' : 'Remove'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-[13px] leading-5 text-neutral-300">
            {isSelf
              ? 'You will lose access to this room immediately, including the conversation history.'
              : `${name} loses access immediately — open sessions are ejected on the next update. Past contributions stay in the transcript.`}
          </p>

          {error ? <Banner tone="error">{error}</Banner> : null}

          <label className="flex items-start gap-2 text-[12px] leading-5 text-neutral-300">
            <input
              type="checkbox"
              checked={ban}
              disabled={busy === 'remove'}
              onChange={(event) => setBan(event.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-red-500"
            />
            <span>
              Ban as well — a banned account keeps no access and cannot be re-invited until an
              administrator lifts the ban.
            </span>
          </label>
        </div>
      </Modal>
    </li>
  )
}

export default MemberRow
