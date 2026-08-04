import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { cache } from 'react'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import RoomWorkspace from '@/app/rooms/[roomId]/RoomWorkspace'
import Banner from '@/components/ui/Banner'
import { loadRoomContext } from '@/lib/server/room-context'
import { createServerSupabase } from '@/lib/supabase/server'
import { CLAUDE_HISTORY_LIMIT } from '@/lib/types'
import type {
  InvitationSummary,
  Message,
  MessageWithSender,
  Profile,
  RoomMember,
  RoomMemberWithProfile,
} from '@/lib/types'

interface RoomPageProps {
  // Next 15 hands route params to pages as a Promise; awaiting is mandatory.
  params: Promise<{ roomId: string }>
}

/**
 * Every column of `invitations` except `token`.
 *
 * The token is a bearer credential for the room and everything this page selects
 * is serialised into the RSC payload, which is to say into the browser. Naming
 * the columns means a live invite link cannot leak by way of a `select('*')`
 * that nobody remembered to strip.
 */
const INVITATION_COLUMNS =
  'id, room_id, email, role, expires_at, accepted_at, revoked_at, invited_by, created_at'

/**
 * `generateMetadata` and the page body both need the room, and both run in the
 * same request. React's `cache` collapses that into one authorisation pass
 * rather than two round trips to Postgres for identical rows.
 */
const loadRoom = cache(loadRoomContext)

/** A readable full-column message, used for every failure this page can render. */
function RoomNotice({
  title,
  tone,
  children,
}: {
  title: string
  tone: 'error' | 'warning'
  children: ReactNode
}) {
  return (
    <main className="flex min-w-0 flex-1 items-center justify-center p-6">
      <div className="w-full max-w-md">
        <Banner tone={tone} title={title}>
          {children}
        </Banner>
        <p className="mt-3 text-center">
          <Link
            href="/rooms"
            className="text-[13px] text-neutral-400 underline underline-offset-2 hover:text-neutral-200"
          >
            Back to your rooms
          </Link>
        </p>
      </div>
    </main>
  )
}

export async function generateMetadata({ params }: RoomPageProps): Promise<Metadata> {
  const { roomId } = await params
  const context = await loadRoom(roomId)
  const name = context.ok && context.data ? context.data.room.name : null

  return {
    // The fallback deliberately names no room: a title is rendered before the
    // access decision is visible to the reader, so it must not confirm that a
    // room they cannot open exists.
    title: name ? `${name} · Collaborative Claude` : 'Room · Collaborative Claude',
    robots: { index: false, follow: false },
  }
}

export default async function RoomPage({ params }: RoomPageProps) {
  const { roomId } = await params

  const context = await loadRoom(roomId)
  if (!context.ok || !context.data) {
    const status = context.status ?? 500
    const reason = context.issues[0]?.message ?? 'This room could not be opened.'

    // 401 is a session that expired between the middleware and this render.
    if (status === 401) redirect(`/login?next=${encodeURIComponent(`/rooms/${roomId}`)}`)

    // 404 covers "no such room" and "not a member" with one indistinguishable
    // answer — see the not-found boundary for this segment.
    if (status === 404) notFound()

    if (status === 403) {
      return (
        <RoomNotice tone="warning" title="You cannot open this room">
          {/* The server's own sentence: it knows whether this is a removal, a
              ban or an unaccepted invitation, and each needs a different reply
              from the reader. */}
          <p>{reason}</p>
        </RoomNotice>
      )
    }

    return (
      <RoomNotice tone="error" title="This room could not be loaded">
        <p>{reason}</p>
      </RoomNotice>
    )
  }

  const { room, profile, member, capabilities } = context.data
  const supabase = await createServerSupabase()

  const [messagesResponse, membersResponse, invitationsResponse, ownerResponse] = await Promise.all([
    supabase
      .from('messages')
      .select('*')
      .eq('room_id', room.id)
      // Newest-first so `limit` keeps the *latest* window; the list is reversed
      // below because the transcript reads oldest-first. The id tiebreak keeps
      // two rows written in the same millisecond from swapping places between
      // this render and the client's own sort.
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(CLAUDE_HISTORY_LIMIT)
      .returns<Message[]>(),
    supabase
      .from('room_members')
      .select('*')
      .eq('room_id', room.id)
      .order('created_at', { ascending: true })
      .returns<RoomMember[]>(),
    // `invitations_select_admin` returns nothing to a collaborator or viewer, so
    // this needs no capability branch: non-admins simply receive an empty list.
    supabase
      .from('invitations')
      .select(INVITATION_COLUMNS)
      .eq('room_id', room.id)
      .is('accepted_at', null)
      .is('revoked_at', null)
      // Expiry is filtered in Postgres so a dead link never renders as pending.
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .returns<InvitationSummary[]>(),
    supabase.from('profiles').select('*').eq('id', room.owner_id).maybeSingle<Profile>(),
  ])

  if (messagesResponse.error) {
    console.error('[rooms/[roomId]] transcript read failed', {
      roomId: room.id,
      message: messagesResponse.error.message,
    })
    return (
      <RoomNotice tone="error" title="The conversation could not be loaded">
        <p>
          {room.name} is there, but its transcript could not be read just now. Reload the page to try
          again.
        </p>
      </RoomNotice>
    )
  }

  if (membersResponse.error) {
    // Fatal rather than degraded: the roster resolves who wrote each message, so
    // rendering without it would attribute the whole transcript to nobody.
    console.error('[rooms/[roomId]] roster read failed', {
      roomId: room.id,
      message: membersResponse.error.message,
    })
    return (
      <RoomNotice tone="error" title="The member list could not be loaded">
        <p>
          Without it the conversation cannot be attributed to anyone, so it is not shown. Reload the
          page to try again.
        </p>
      </RoomNotice>
    )
  }

  const memberRows = membersResponse.data ?? []

  // `room_members` and `messages` both reference `auth.users`, not `profiles`,
  // so PostgREST has no relationship to embed and the join is done here. It
  // depends on the roster ids, which is why it cannot join the batch above.
  const userIds = [...new Set(memberRows.map((row) => row.user_id))]
  const profilesResponse =
    userIds.length === 0
      ? { data: [] as Profile[], error: null }
      : await supabase.from('profiles').select('*').in('id', userIds).returns<Profile[]>()

  if (profilesResponse.error) {
    // Non-fatal: names degrade, access does not. The client's realtime hook
    // re-fetches the roster on connect and fills the gaps in.
    console.error('[rooms/[roomId]] profile read failed', {
      roomId: room.id,
      message: profilesResponse.error.message,
    })
  }

  const profileByUser = new Map<string, Profile>()
  for (const row of profilesResponse.data ?? []) profileByUser.set(row.id, row)

  const members: RoomMemberWithProfile[] = memberRows.map((row) => ({
    ...row,
    profile: profileByUser.get(row.user_id) ?? null,
    // Presence is a client fact carried by the realtime channel, and the browser
    // renders every member as offline until that channel syncs. Asserting
    // anything else here would make the server HTML and the first client render
    // disagree, which React reports as a hydration mismatch.
    is_online: false,
  }))

  const memberByUser = new Map(memberRows.map((row) => [row.user_id, row]))

  const initialMessages: MessageWithSender[] = (messagesResponse.data ?? [])
    .map((message) => {
      // Claude and system rows have no sender by design. A human sender missing
      // from the roster means their membership row was deleted outright, so
      // there is no name to show and none is invented.
      const senderRow = message.sender_id ? memberByUser.get(message.sender_id) : undefined
      return {
        ...message,
        sender: senderRow ? (profileByUser.get(senderRow.user_id) ?? null) : null,
        sender_role: senderRow?.role ?? null,
      }
    })
    .reverse()

  if (invitationsResponse.error) {
    console.error('[rooms/[roomId]] invitation read failed', {
      roomId: room.id,
      message: invitationsResponse.error.message,
    })
  }
  if (ownerResponse.error) {
    console.error('[rooms/[roomId]] owner profile read failed', {
      roomId: room.id,
      message: ownerResponse.error.message,
    })
  }

  const corePrompterName =
    ownerResponse.data?.display_name ??
    profileByUser.get(room.owner_id)?.display_name ??
    'the Core Prompter'

  return (
    <RoomWorkspace
      room={room}
      currentUser={profile}
      currentRole={member.role}
      capabilities={capabilities}
      initialMessages={initialMessages}
      initialMembers={members}
      invitations={invitationsResponse.data ?? []}
      corePrompterName={corePrompterName}
    />
  )
}
