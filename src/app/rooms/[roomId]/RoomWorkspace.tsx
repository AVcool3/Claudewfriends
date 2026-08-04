'use client'

/**
 * The two client columns of the shell, and the single owner of the roster they
 * share.
 *
 * `ChatArea` holds the realtime subscription and hands its member list back
 * through `onMembersChange`; the access column renders that same list. A second
 * subscription for the right-hand column would double the socket traffic and
 * could disagree with the centre column for a frame — long enough to show a
 * member who has just been removed.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import AccessPanel from '@/components/access/AccessPanel'
import ChatArea from '@/components/chat/ChatArea'
import RoomSettings from '@/components/sidebar/RoomSettings'
import type { Capability } from '@/lib/permissions'
import type {
  InvitationSummary,
  MessageWithSender,
  Profile,
  Role,
  Room,
  RoomMemberWithProfile,
} from '@/lib/types'

export interface RoomWorkspaceProps {
  room: Room
  currentUser: Profile
  currentRole: Role
  capabilities: Record<Capability, boolean>
  initialMessages: MessageWithSender[]
  initialMembers: RoomMemberWithProfile[]
  invitations: InvitationSummary[]
  corePrompterName: string
}

export function RoomWorkspace({
  room,
  currentUser,
  currentRole,
  capabilities,
  initialMessages,
  initialMembers,
  invitations,
  corePrompterName,
}: RoomWorkspaceProps) {
  const router = useRouter()

  const [members, setMembers] = useState<RoomMemberWithProfile[]>(initialMembers)
  const [roomId, setRoomId] = useState(room.id)

  // Navigating between two rooms reuses this component instance, and `useState`
  // ignores its initialiser on a re-render. Without this the new room would show
  // the previous room's roster until the realtime channel resubscribed.
  if (roomId !== room.id) {
    setRoomId(room.id)
    setMembers(initialMembers)
  }

  /*
   * A membership or invitation change re-runs the server component that fed this
   * page. The roster itself arrives over realtime either way, but the pending
   * invitations below are server-fetched props and have no live channel of their
   * own, so a refresh is the only thing that retires an accepted invite.
   */
  const refresh = () => router.refresh()

  return (
    <div className="flex min-w-0 flex-1 overflow-hidden">
      <ChatArea
        roomId={room.id}
        room={room}
        currentUser={currentUser}
        currentRole={currentRole}
        capabilities={capabilities}
        initialMessages={initialMessages}
        initialMembers={initialMembers}
        corePrompterName={corePrompterName}
        onMembersChange={setMembers}
      />

      {/*
       * Grid rather than flex: the access panel styles itself `h-full shrink-0`,
       * which in a flex column would refuse to give the settings block above it
       * any room and overflow the viewport. A `minmax(0, 1fr)` track resolves
       * `h-full` against the space actually left over.
       */}
      <div className="grid h-full w-80 shrink-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
        {/*
         * RoomSettings is a sidebar component and would normally sit under the
         * room list. It cannot: the sidebar lives in `rooms/layout.tsx`, which is
         * above the `[roomId]` segment and therefore never learns which room is
         * open, so its own branch for this panel is unreachable. It is rendered
         * here — with the room in hand — instead of nowhere.
         */}
        <div className="border-l border-neutral-800 bg-neutral-900">
          <RoomSettings room={room} capabilities={capabilities} />
        </div>

        <AccessPanel
          roomId={room.id}
          members={members}
          invitations={invitations}
          capabilities={capabilities}
          currentUserId={currentUser.id}
          ownerId={room.owner_id}
          isLocked={room.is_locked}
          onChanged={refresh}
        />
      </div>
    </div>
  )
}

export default RoomWorkspace
