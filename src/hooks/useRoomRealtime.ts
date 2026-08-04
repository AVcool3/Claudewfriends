'use client'

/**
 * The room's live wire.
 *
 * One Supabase channel per room carries three independent streams:
 *
 *   - `postgres_changes` on `messages` and `room_members`, filtered server-side
 *     by `room_id` and further filtered by RLS, so a tampered id yields nothing
 *   - presence, which drives the online dot
 *   - a `typing` broadcast, which is deliberately ephemeral and never stored
 *
 * The subscription is also the room's eviction mechanism: a membership row that
 * stops being `active` sets `error: 'access_revoked'` here, which is what makes
 * "removal takes effect immediately" visible rather than merely true in the
 * database.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'

import { createClient } from '@/lib/supabase/client'
import type {
  Message,
  MessageWithSender,
  Profile,
  Role,
  RoomMember,
  RoomMemberWithProfile,
  TypingIndicator,
} from '@/lib/types'

export interface RoomRealtimeState {
  messages: MessageWithSender[]
  members: RoomMemberWithProfile[]
  typing: TypingIndicator[]
  connection: 'connecting' | 'connected' | 'error'
  error: string | null
}

export interface UseRoomRealtimeArgs {
  roomId: string
  currentUserId: string
  currentUserName: string
  initialMessages: MessageWithSender[]
  initialMembers: RoomMemberWithProfile[]
}

export type UseRoomRealtimeResult = RoomRealtimeState & {
  broadcastTyping: () => void
  /** Optimistically append; replaced when the realtime INSERT lands. */
  addOptimistic: (message: MessageWithSender) => void
  removeOptimistic: (id: string) => void
  refreshMembers: () => Promise<void>
}

/**
 * The realtime generics are constrained to `{ [key: string]: any }`, and a
 * TypeScript `interface` never satisfies that — only a type alias picks up an
 * implicit index signature. Re-expressing the row types as mapped types keeps
 * the payloads strongly typed without an `any` anywhere.
 */
type MessageRow = { [K in keyof Message]: Message[K] }
type MemberRow = { [K in keyof RoomMember]: RoomMember[K] }
type PresenceMeta = { user_id: string; display_name: string; online_at: string }

/** At most one `typing` broadcast per sender in this window. */
const TYPING_THROTTLE_MS = 2_000
/** How long a typing indicator survives without a refresh. */
const TYPING_TTL_MS = 4_000
const TYPING_SWEEP_MS = 1_000
/**
 * Presence is re-tracked rather than `last_seen_at` being PATCHed on a timer:
 * a per-client write every 30s would be a write storm on a busy room for a fact
 * the presence channel already knows. `last_seen_at` stays a server-written
 * fallback for members who are offline entirely.
 */
const PRESENCE_HEARTBEAT_MS = 30_000

/** Optimistic rows carry a client-generated id with this prefix. */
const OPTIMISTIC_PREFIX = 'temp-'

export function isOptimisticId(id: string): boolean {
  return id.startsWith(OPTIMISTIC_PREFIX)
}

/** Mints an id for an optimistic row. Never reaches the database. */
export function optimisticId(): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${OPTIMISTIC_PREFIX}${random}`
}

/**
 * Creation time, then id. The tiebreak matters: two rows written in the same
 * millisecond would otherwise swap places between renders, and `created_at`
 * comes back as a string whose lexical order is not the chronological one once
 * Postgres varies the fractional-second precision.
 */
function compareMessages(a: MessageWithSender, b: MessageWithSender): number {
  const left = Date.parse(a.created_at)
  const right = Date.parse(b.created_at)
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right
  return a.id.localeCompare(b.id)
}

function sortMessages(rows: MessageWithSender[]): MessageWithSender[] {
  return [...rows].sort(compareMessages)
}

interface SenderIdentity {
  sender: Profile | null
  sender_role: Role | null
  /** False when no membership row exists for this sender at all. */
  known: boolean
}

function lookupSender(members: RoomMemberWithProfile[], senderId: string | null): SenderIdentity {
  // Claude and system rows have no sender by design, so they are "known".
  if (!senderId) return { sender: null, sender_role: null, known: true }
  const row = members.find((member) => member.user_id === senderId)
  if (!row) return { sender: null, sender_role: null, known: false }
  return { sender: row.profile, sender_role: row.role, known: true }
}

/**
 * Inserts or replaces a row.
 *
 * Two different duplicates have to be collapsed here. A row already present by
 * id is an UPDATE (an approval, a rejection, a late `processed_content`) and
 * simply replaces its predecessor. A row that is new by id may still be the
 * server's version of an optimistic row this client appended a moment ago —
 * matched on sender plus exact body, which holds because the composer stores
 * the *normalised* text it also sends, so both sides compare the same string.
 */
function upsertMessage(list: MessageWithSender[], incoming: MessageWithSender): MessageWithSender[] {
  const index = list.findIndex((row) => row.id === incoming.id)
  if (index >= 0) {
    const next = [...list]
    next[index] = {
      ...incoming,
      // A realtime payload carries the raw row and no joined profile. Keeping
      // the sender we had already resolved stops an UPDATE from blanking a name
      // that is on screen.
      sender: incoming.sender ?? list[index].sender,
      sender_role: incoming.sender_role ?? list[index].sender_role,
    }
    return sortMessages(next)
  }

  const withoutOptimistic = list.filter(
    (row) =>
      !(
        isOptimisticId(row.id) &&
        row.sender_id === incoming.sender_id &&
        row.original_content === incoming.original_content
      ),
  )
  return sortMessages([...withoutOptimistic, incoming])
}

function readTypingPayload(value: unknown): { user_id: string; display_name: string } | null {
  if (typeof value !== 'object' || value === null) return null
  // Broadcast payloads arrive as untyped JSON from another client, so every
  // field is checked before it is trusted enough to render.
  const record = value as Record<string, unknown>
  const userId = record.user_id
  const displayName = record.display_name
  if (typeof userId !== 'string' || userId.length === 0) return null
  return {
    user_id: userId,
    display_name:
      typeof displayName === 'string' && displayName.trim().length > 0 ? displayName : 'Someone',
  }
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export function useRoomRealtime({
  roomId,
  currentUserId,
  currentUserName,
  initialMessages,
  initialMembers,
}: UseRoomRealtimeArgs): UseRoomRealtimeResult {
  const [messages, setMessages] = useState<MessageWithSender[]>(() => sortMessages(initialMessages))
  const [memberRows, setMemberRows] = useState<RoomMemberWithProfile[]>(initialMembers)
  const [onlineIds, setOnlineIds] = useState<string[]>([])
  const [typing, setTyping] = useState<TypingIndicator[]>([])
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'error'>('connecting')
  const [error, setError] = useState<string | null>(null)

  // Every setState below is guarded by this. A `postgres_changes` payload can
  // land between the unmount and `removeChannel` resolving, and updating a
  // dropped component is a warning in development and a leak in production.
  const mountedRef = useRef(true)
  const channelRef = useRef<RealtimeChannel | null>(null)
  const memberRowsRef = useRef(memberRows)
  const lastTypingSentRef = useRef(0)
  const memberFetchInFlightRef = useRef(false)
  // Once access is gone it stays gone for this mount: a later CHANNEL_ERROR or
  // a reconnect must not overwrite the reason the user is being ejected.
  const revokedRef = useRef(false)

  useEffect(() => {
    memberRowsRef.current = memberRows
  }, [memberRows])

  const members = useMemo<RoomMemberWithProfile[]>(() => {
    const online = new Set(onlineIds)
    return memberRows.map((member) => ({ ...member, is_online: online.has(member.user_id) }))
  }, [memberRows, onlineIds])

  const refreshMembers = useCallback(async () => {
    try {
      const response = await fetch(`/api/rooms/${roomId}/members`, {
        headers: { accept: 'application/json' },
      })
      if (!response.ok) return
      const payload: unknown = await response.json()
      if (!mountedRef.current || typeof payload !== 'object' || payload === null) return
      const { members: rows } = payload as { members?: unknown }
      if (!Array.isArray(rows)) return
      setMemberRows(rows as RoomMemberWithProfile[])
    } catch {
      // A failed roster refresh is not worth surfacing: the names already on
      // screen stay correct and the next payload retries.
    }
  }, [roomId])

  /**
   * A sender we have never seen — someone who joined mid-session — triggers one
   * roster fetch rather than rendering "Unknown". The in-flight guard keeps a
   * burst of their messages from firing a request each.
   */
  const requestMemberRefresh = useCallback(() => {
    if (memberFetchInFlightRef.current) return
    memberFetchInFlightRef.current = true
    void refreshMembers().finally(() => {
      memberFetchInFlightRef.current = false
    })
  }, [refreshMembers])

  /**
   * Retry of the sender lookup: once a roster fetch lands, any message still
   * holding a null sender gets its name filled in without waiting for another
   * payload to touch the row.
   */
  useEffect(() => {
    setMessages((prev) => {
      let changed = false
      const next = prev.map((row) => {
        if (!row.sender_id || row.sender) return row
        const identity = lookupSender(memberRows, row.sender_id)
        if (!identity.known || !identity.sender) return row
        changed = true
        return { ...row, sender: identity.sender, sender_role: identity.sender_role }
      })
      return changed ? next : prev
    })
  }, [memberRows])

  const addOptimistic = useCallback((message: MessageWithSender) => {
    setMessages((prev) => upsertMessage(prev, message))
  }, [])

  const removeOptimistic = useCallback((id: string) => {
    setMessages((prev) => {
      const next = prev.filter((row) => row.id !== id)
      return next.length === prev.length ? prev : next
    })
  }, [])

  const broadcastTyping = useCallback(() => {
    const channel = channelRef.current
    if (!channel || revokedRef.current) return
    const now = Date.now()
    if (now - lastTypingSentRef.current < TYPING_THROTTLE_MS) return
    lastTypingSentRef.current = now
    void channel.send({
      type: 'broadcast',
      event: 'typing',
      payload: { user_id: currentUserId, display_name: currentUserName },
    })
  }, [currentUserId, currentUserName])

  useEffect(() => {
    mountedRef.current = true
    revokedRef.current = false

    const supabase = createClient()
    const channel = supabase.channel(`room:${roomId}`, {
      config: {
        // Keyed by user so a second tab replaces the first entry instead of
        // counting the same person twice.
        presence: { key: currentUserId },
        // Our own typing indicator is never useful to us.
        broadcast: { self: false },
      },
    })
    channelRef.current = channel

    function revokeAccess() {
      if (revokedRef.current) return
      revokedRef.current = true
      if (!mountedRef.current) return
      setConnection('error')
      setError('access_revoked')
    }

    function ingestMessage(row: Message) {
      if (!mountedRef.current) return
      const identity = lookupSender(memberRowsRef.current, row.sender_id)
      if (!identity.known) requestMemberRefresh()
      setMessages((prev) =>
        upsertMessage(prev, { ...row, sender: identity.sender, sender_role: identity.sender_role }),
      )
    }

    function applyPresence() {
      if (!mountedRef.current) return
      const state = channel.presenceState<PresenceMeta>()
      const ids = new Set<string>()
      for (const entries of Object.values(state)) {
        for (const entry of entries) {
          if (typeof entry.user_id === 'string') ids.add(entry.user_id)
        }
      }
      const next = [...ids].sort()
      // Compared before storing so a presence sync that changed nothing does not
      // re-render every member row.
      setOnlineIds((prev) => (sameIds(prev, next) ? prev : next))
    }

    channel.on<MessageRow>(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${roomId}` },
      (payload) => ingestMessage(payload.new),
    )

    channel.on<MessageRow>(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'messages', filter: `room_id=eq.${roomId}` },
      (payload) => ingestMessage(payload.new),
    )

    channel.on<MemberRow>(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'room_members', filter: `room_id=eq.${roomId}` },
      () => {
        // The payload has no joined profile, so a brand new member needs the
        // roster endpoint before their name can be rendered.
        requestMemberRefresh()
      },
    )

    channel.on<MemberRow>(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'room_members', filter: `room_id=eq.${roomId}` },
      (payload) => {
        const row = payload.new
        if (row.user_id === currentUserId && row.status !== 'active') {
          revokeAccess()
          return
        }
        if (!mountedRef.current) return

        const known = memberRowsRef.current.some((member) => member.id === row.id)
        if (!known) {
          requestMemberRefresh()
          return
        }
        // The profile is already in hand for a member we know, so the changed
        // columns are patched in place rather than costing a round trip.
        setMemberRows((prev) =>
          prev.map((member) => (member.id === row.id ? { ...member, ...row } : member)),
        )
      },
    )

    channel.on<MemberRow>(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'room_members', filter: `room_id=eq.${roomId}` },
      (payload) => {
        // A DELETE payload carries only the replica identity — the primary key
        // under Postgres' default setting — so the row is matched by id and
        // `old.user_id` is not relied on.
        const deletedId = payload.old.id
        if (typeof deletedId !== 'string') {
          requestMemberRefresh()
          return
        }
        const self = memberRowsRef.current.find((member) => member.user_id === currentUserId)
        if (self && self.id === deletedId) {
          revokeAccess()
          return
        }
        if (!mountedRef.current) return
        setMemberRows((prev) => prev.filter((member) => member.id !== deletedId))
      },
    )

    channel.on('broadcast', { event: 'typing' }, (message) => {
      const entry = readTypingPayload(message.payload)
      if (!entry || entry.user_id === currentUserId || !mountedRef.current) return
      const at = Date.now()
      setTyping((prev) => [...prev.filter((row) => row.user_id !== entry.user_id), { ...entry, at }])
    })

    channel.on('presence', { event: 'sync' }, applyPresence)

    let heartbeat: number | null = null

    channel.subscribe((status) => {
      if (revokedRef.current || !mountedRef.current) return

      if (status === 'SUBSCRIBED') {
        setConnection('connected')
        setError(null)
        const track = () => {
          void channel.track({
            user_id: currentUserId,
            display_name: currentUserName,
            online_at: new Date().toISOString(),
          })
        }
        track()
        if (heartbeat === null) heartbeat = window.setInterval(track, PRESENCE_HEARTBEAT_MS)
        // The roster is re-read on (re)connect because anything that changed
        // while the socket was down produced no payload for us to apply.
        requestMemberRefresh()
        return
      }

      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        setConnection('error')
        setError('The live connection dropped. Reconnecting…')
      }
    })

    return () => {
      mountedRef.current = false
      if (heartbeat !== null) window.clearInterval(heartbeat)
      channelRef.current = null
      void supabase.removeChannel(channel)
    }
  }, [roomId, currentUserId, currentUserName, requestMemberRefresh])

  /**
   * Typing entries expire on a sweep rather than a timer per entry: one interval
   * that only exists while somebody is typing is cheaper than N timers, and it
   * cannot leave a stray timeout behind on unmount.
   */
  useEffect(() => {
    if (typing.length === 0) return
    const timer = window.setInterval(() => {
      const cutoff = Date.now() - TYPING_TTL_MS
      setTyping((prev) => {
        const next = prev.filter((entry) => entry.at > cutoff)
        return next.length === prev.length ? prev : next
      })
    }, TYPING_SWEEP_MS)
    return () => window.clearInterval(timer)
  }, [typing.length])

  return {
    messages,
    members,
    typing,
    connection,
    error,
    broadcastTyping,
    addOptimistic,
    removeOptimistic,
    refreshMembers,
  }
}

export default useRoomRealtime
