'use client'

/**
 * The centre column, and the only owner of the realtime hook.
 *
 * Members flow back out through `onMembersChange` so the access panel renders
 * the same roster this column is using — two independent subscriptions to the
 * same room would double the socket traffic and could disagree for a frame.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import Composer from '@/components/chat/Composer'
import MessageList from '@/components/chat/MessageList'
import PendingQueue from '@/components/chat/PendingQueue'
import TypingRow from '@/components/chat/TypingRow'
import Badge from '@/components/ui/Badge'
import Banner from '@/components/ui/Banner'
import useRoomRealtime from '@/hooks/useRoomRealtime'
import {
  denialReason,
  requiresApproval,
  roomContext,
  type Capability,
  type MembershipContext,
} from '@/lib/permissions'
import type { MessageWithSender, Profile, Role, Room, RoomMemberWithProfile } from '@/lib/types'

export interface ChatAreaProps {
  roomId: string
  room: Room
  currentUser: Profile
  currentRole: Role
  capabilities: Record<Capability, boolean>
  initialMessages: MessageWithSender[]
  initialMembers: RoomMemberWithProfile[]
  corePrompterName: string
  onMembersChange?: (members: RoomMemberWithProfile[]) => void
}

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

export function ChatArea({
  roomId,
  room,
  currentUser,
  currentRole,
  capabilities,
  initialMessages,
  initialMembers,
  corePrompterName,
  onMembersChange,
}: ChatAreaProps) {
  const { messages, members, typing, connection, error, broadcastTyping, addOptimistic, removeOptimistic } =
    useRoomRealtime({
      roomId,
      currentUserId: currentUser.id,
      currentUserName: currentUser.display_name,
      initialMessages,
      initialMembers,
    })

  const [awaitingClaude, setAwaitingClaude] = useState(false)

  // Held in a ref so the effect depends on `members` alone. Room pages routinely
  // pass an inline arrow, and making that identity a dependency would fire the
  // callback on every render of the parent.
  const onMembersChangeRef = useRef(onMembersChange)
  useEffect(() => {
    onMembersChangeRef.current = onMembersChange
  }, [onMembersChange])

  useEffect(() => {
    onMembersChangeRef.current?.(members)
  }, [members])

  const membership = useMemo<MembershipContext>(
    () => ({
      // A viewer of this component always has an active membership — the server
      // page would not have rendered it otherwise, and a revocation replaces the
      // column entirely (below) rather than downgrading this object.
      role: currentRole,
      status: 'active',
      isOwner: currentUser.id === room.owner_id,
    }),
    [currentRole, currentUser.id, room.owner_id],
  )

  const roomCtx = useMemo(() => roomContext(room), [room])

  const canApprove = capabilities['room.approve_message']
  const canSend = capabilities['room.send_message']
  const queues = requiresApproval(membership, roomCtx)

  const pending = useMemo(
    () => messages.filter((message) => message.approval_status === 'pending'),
    [messages],
  )

  const activeMemberCount = members.filter((member) => member.status === 'active').length

  if (connection === 'error' && error === 'access_revoked') {
    return (
      <section className="flex min-w-0 flex-1 items-center justify-center p-8">
        <div className="w-full max-w-md">
          <Banner tone="error" title="Your access to this room was removed">
            <p>
              The Core Prompter or an administrator removed you from{' '}
              <span className="font-medium">{room.name}</span>. The conversation is no longer
              visible to you, and messages you already contributed stay in the room&apos;s
              transcript.
            </p>
            <p className="mt-2">
              <a
                href="/rooms"
                className="font-medium text-red-100 underline underline-offset-2 hover:text-white"
              >
                Back to your rooms
              </a>
            </p>
          </Banner>
        </div>
      </section>
    )
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-neutral-950">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-800 bg-neutral-900 px-4 py-3">
        <h1 className="min-w-0 max-w-full truncate text-sm font-semibold text-neutral-100" title={room.name}>
          {room.name}
        </h1>

        {room.collaboration_mode === 'approval_required' ? (
          <Badge tone="core">Approval required</Badge>
        ) : (
          <Badge tone="neutral">Open collaboration</Badge>
        )}

        {room.is_locked ? (
          <Badge tone="neutral">
            <LockIcon />
            <span className="ml-1">Locked</span>
          </Badge>
        ) : null}

        {!room.allow_collaborator_messages && !room.is_locked ? (
          <Badge tone="neutral">Collaborator messages paused</Badge>
        ) : null}

        <span className="min-w-0 flex-1" />

        <span className="text-[11px] text-neutral-500">
          {activeMemberCount} {activeMemberCount === 1 ? 'member' : 'members'}
        </span>

        <span className="text-[11px] text-neutral-600" title={`Core Prompter: ${corePrompterName}`}>
          · Core Prompter {corePrompterName}
        </span>

        {connection !== 'connected' ? (
          <span
            className="rounded-full border border-neutral-700 bg-neutral-800/60 px-2 py-0.5 text-[11px] text-neutral-400"
            title={error ?? undefined}
          >
            {connection === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
          </span>
        ) : null}
      </header>

      {/* Rendered for the Core Prompter alone — `room.approve_message` resolves
          to them, and the approve/combine routes re-check it server-side. */}
      {canApprove ? (
        <PendingQueue roomId={roomId} pending={pending} onAwaitingClaude={setAwaitingClaude} />
      ) : null}

      <MessageList
        messages={messages}
        currentUserId={currentUser.id}
        canSeePending={canApprove}
        claudeThinking={awaitingClaude}
      />

      <TypingRow typing={typing} currentUserId={currentUser.id} />

      <Composer
        roomId={roomId}
        currentUser={currentUser}
        currentRole={currentRole}
        canSend={canSend}
        denialReason={denialReason('room.send_message', membership, roomCtx)}
        queues={queues}
        onAwaitingClaude={setAwaitingClaude}
        addOptimistic={addOptimistic}
        removeOptimistic={removeOptimistic}
        onTyping={broadcastTyping}
      />
    </section>
  )
}

export default ChatArea
