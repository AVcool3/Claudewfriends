'use client'

import { useEffect, useMemo, useState } from 'react'
import InviteDialog from '@/components/access/InviteDialog'
import MemberRow, { ROLE_TONE, type PermissionVerdict } from '@/components/access/MemberRow'
import Badge from '@/components/ui/Badge'
import Banner from '@/components/ui/Banner'
import Button from '@/components/ui/Button'
import {
  canChangeRole,
  canRemoveMember,
  membershipContext,
  type Capability,
  type MembershipContext,
} from '@/lib/permissions'
import {
  ROLE_LABELS,
  type InvitationSummary,
  type Role,
  type RoomMemberWithProfile,
} from '@/lib/types'

export interface AccessPanelProps {
  roomId: string
  members: RoomMemberWithProfile[]
  invitations: InvitationSummary[]
  capabilities: Record<Capability, boolean>
  currentUserId: string
  ownerId: string
  isLocked: boolean
  onChanged?: () => void
}

const ROLE_RANK: Record<Role, number> = {
  core_prompter: 3,
  administrator: 2,
  collaborator: 1,
  viewer: 0,
}

const NO_PERMISSION = 'You do not have permission to manage members in this room.'

/** A membership that grants nothing — used when the viewer has no row at all. */
const NO_MEMBERSHIP: MembershipContext = { role: 'viewer', status: 'removed', isOwner: false }

function LockIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      className="h-3 w-3 shrink-0"
    >
      <rect x="3.25" y="7" width="9.5" height="6.5" rx="1.5" />
      <path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Combines the server-resolved capability with the fine-grained guard. The
 * capability answers "may this viewer manage members at all"; the guard answers
 * "may they touch *this* member" and supplies the sentence explaining a no.
 */
function gate(capable: boolean, verdict: { allowed: boolean; reason?: string }): PermissionVerdict {
  if (!capable) return { allowed: false, reason: NO_PERMISSION }
  return verdict.allowed ? { allowed: true } : { allowed: false, reason: verdict.reason }
}

export function AccessPanel({
  roomId,
  members,
  invitations,
  capabilities,
  currentUserId,
  ownerId,
  isLocked,
  onChanged,
}: AccessPanelProps) {
  const [inviting, setInviting] = useState(false)

  /*
   * Expiry is compared against a clock read after mount. Calling Date.now()
   * during render would make the server HTML and the first client render
   * disagree for any invitation sitting on the boundary, which React reports as
   * a hydration mismatch; until this lands nothing is classed as expired.
   */
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    setNow(Date.now())
  }, [invitations])

  const roster = useMemo(() => {
    // `removed` and `banned` rows are history, not access. The panel answers
    // "who can see this room right now".
    const visible = members.filter((m) => m.status === 'active' || m.status === 'invited')
    return [...visible].sort((a, b) => {
      const byRole = ROLE_RANK[b.role] - ROLE_RANK[a.role]
      if (byRole !== 0) return byRole
      const nameA = a.profile?.display_name ?? ''
      const nameB = b.profile?.display_name ?? ''
      return nameA.localeCompare(nameB)
    })
  }, [members])

  const actor = useMemo<MembershipContext>(() => {
    const self = members.find((m) => m.user_id === currentUserId)
    return self ? membershipContext(self, { owner_id: ownerId }) : NO_MEMBERSHIP
  }, [members, currentUserId, ownerId])

  const pending = useMemo(
    () => invitations.filter((invitation) => !invitation.accepted_at && !invitation.revoked_at),
    [invitations],
  )

  const canInvite = capabilities['room.invite']

  return (
    <aside
      aria-label="Room access"
      className="flex h-full w-80 shrink-0 flex-col border-l border-neutral-800 bg-neutral-900"
    >
      <header className="flex items-center gap-2 border-b border-neutral-800 px-4 py-3.5">
        <h2 className="min-w-0 flex-1 text-sm font-semibold text-neutral-100">Access</h2>
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-neutral-700 bg-neutral-800/60 px-2 py-0.5 text-[11px] text-neutral-300"
          title="Only invited accounts can open this room."
        >
          <LockIcon />
          Private room
        </span>
      </header>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {isLocked ? (
          <div className="mb-3 px-1">
            <Banner tone="warning" title="Room locked">
              Contributions are frozen — only the Core Prompter can send while the lock is on.
            </Banner>
          </div>
        ) : null}

        <h3 className="px-2 text-[11px] font-semibold tracking-wide text-neutral-500 uppercase">
          Members ({roster.length})
        </h3>

        <ul className="mt-1.5 flex flex-col gap-0.5">
          {roster.map((member) => {
            const target = membershipContext(member, { owner_id: ownerId })
            const isCorePrompter = target.isOwner || member.role === 'core_prompter'
            return (
              <MemberRow
                key={member.id}
                roomId={roomId}
                member={member}
                isSelf={member.user_id === currentUserId}
                isCorePrompter={isCorePrompter}
                /*
                 * `collaborator` stands in for "any assignable role" here: the
                 * only role-specific denial is `core_prompter`, which the row's
                 * select never offers, so probing with it would report a
                 * restriction the UI cannot actually hit.
                 */
                roleChange={gate(
                  capabilities['room.change_role'],
                  canChangeRole(actor, target, 'collaborator'),
                )}
                removal={gate(capabilities['room.remove_member'], canRemoveMember(actor, target))}
                onChanged={onChanged}
              />
            )
          })}
        </ul>

        <div className="mt-5">
          <h3 className="px-2 text-[11px] font-semibold tracking-wide text-neutral-500 uppercase">
            Pending invitations ({pending.length})
          </h3>

          {pending.length === 0 ? (
            <p className="mt-1.5 px-2 text-[11px] leading-4 text-neutral-600">
              No invitations are waiting to be accepted.
            </p>
          ) : (
            <ul className="mt-1.5 flex flex-col gap-1">
              {pending.map((invitation) => {
                const expired = now !== null && Date.parse(invitation.expires_at) <= now
                return (
                  <li
                    key={invitation.id}
                    className="rounded-lg border border-neutral-800 bg-neutral-950/40 px-2.5 py-2"
                  >
                    <p
                      className="truncate text-[11px] font-medium text-neutral-200"
                      title={invitation.email}
                    >
                      {invitation.email}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Badge tone={ROLE_TONE[invitation.role]}>{ROLE_LABELS[invitation.role]}</Badge>
                      {expired ? <Badge tone="neutral">Expired</Badge> : null}
                      {/*
                       * Sliced off the ISO string rather than formatted with
                       * toLocaleDateString, whose output depends on the
                       * renderer's locale and timezone and so differs between
                       * the server HTML and the browser.
                       */}
                      <span className="text-[11px] text-neutral-600">
                        {expired ? 'expired' : 'expires'} {invitation.expires_at.slice(0, 10)}
                      </span>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="border-t border-neutral-800 px-3 py-3">
        <Button
          size="sm"
          className="w-full"
          disabled={!canInvite}
          title={canInvite ? undefined : 'Only the Core Prompter or an administrator can invite.'}
          onClick={() => setInviting(true)}
        >
          Invite user
        </Button>
        <p className="mt-1.5 text-[11px] leading-4 text-neutral-500">
          Invitations are single-use links bound to one email address.
        </p>
      </div>

      <InviteDialog
        open={inviting}
        roomId={roomId}
        onClose={() => setInviting(false)}
        onInvited={onChanged}
      />
    </aside>
  )
}

export default AccessPanel
