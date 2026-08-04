'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Banner from '@/components/ui/Banner'
import Button from '@/components/ui/Button'

export interface AcceptInviteProps {
  token: string
  signedInEmail: string | null
}

type Phase = 'idle' | 'working' | 'accepted' | 'failed'

/**
 * The API forwards the failure names raised by `public.accept_invitation`.
 * Mapping them here keeps the raw Postgres error strings off the screen while
 * still telling the user which of the several distinct failures they hit.
 */
const FAILURE_MESSAGES: Record<string, string> = {
  not_authenticated: 'Your session expired. Sign in again and reopen this link.',
  invitation_invalid: 'This invitation link is not valid. Ask for a fresh one.',
  invitation_revoked: 'This invitation was revoked by a room administrator.',
  invitation_already_accepted:
    'This invitation has already been used. If you accepted it earlier, the room is in your list.',
  invitation_expired: 'This invitation has expired. Ask a room administrator to send a new one.',
  invitation_email_mismatch:
    'This invitation was issued to a different email address. Sign in as that address to accept it.',
  membership_banned: 'This account is banned from the room. Only an administrator can lift that.',
  rate_limited: 'Too many attempts. Wait a moment and try again.',
}

function readFailure(payload: unknown, status: number): { message: string; code: string | null } {
  const body = (typeof payload === 'object' && payload !== null ? payload : {}) as {
    error?: unknown
    code?: unknown
  }
  const code = typeof body.code === 'string' ? body.code : null
  const mapped = code ? FAILURE_MESSAGES[code] : undefined
  if (mapped) return { message: mapped, code }

  // Some failures arrive with the name in `error` rather than `code`.
  const raw = typeof body.error === 'string' ? body.error : ''
  const fromRaw = FAILURE_MESSAGES[raw]
  if (fromRaw) return { message: fromRaw, code: raw }

  if (raw) return { message: raw, code }
  return { message: `Could not accept this invitation (HTTP ${status}).`, code }
}

export default function AcceptInvite({ token, signedInEmail }: AcceptInviteProps) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('idle')
  const [failure, setFailure] = useState<{ message: string; code: string | null } | null>(null)

  async function accept() {
    setPhase('working')
    setFailure(null)

    try {
      const response = await fetch('/api/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })

      const payload: unknown = await response.json().catch(() => null)

      if (!response.ok) {
        setFailure(readFailure(payload, response.status))
        setPhase('failed')
        return
      }

      const roomId =
        typeof payload === 'object' && payload !== null && 'room_id' in payload
          ? (payload as { room_id?: unknown }).room_id
          : undefined

      if (typeof roomId !== 'string' || roomId.length === 0) {
        setFailure({ message: 'The invitation was accepted but the room could not be resolved.', code: null })
        setPhase('failed')
        return
      }

      setPhase('accepted')
      router.replace(`/rooms/${roomId}`)
      // Membership just changed, so the cached room list rendered on the server
      // for a non-member is stale.
      router.refresh()
    } catch {
      setFailure({ message: 'Network error while accepting the invitation. Try again.', code: null })
      setPhase('failed')
    }
  }

  const alreadyAccepted = failure?.code === 'invitation_already_accepted'
  const wrongAccount = failure?.code === 'invitation_email_mismatch'

  return (
    <div className="mt-4 space-y-4">
      <p className="text-sm leading-6 text-neutral-400">
        Accepting adds this account to the room and grants the role you were invited with.
      </p>

      <div className="rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2.5 text-xs text-neutral-400">
        Signed in as{' '}
        <span className="font-medium text-neutral-200">{signedInEmail ?? 'an account with no email'}</span>
      </div>

      {failure ? (
        <Banner tone={alreadyAccepted ? 'info' : 'error'} title="Invitation not accepted">
          {failure.message}
        </Banner>
      ) : null}

      {phase !== 'accepted' && !alreadyAccepted ? (
        <Button loading={phase === 'working'} onClick={accept} className="w-full">
          {phase === 'failed' ? 'Try again' : 'Accept invitation'}
        </Button>
      ) : null}

      {phase === 'accepted' ? (
        <Banner tone="success" title="You are in">
          Taking you to the room…
        </Banner>
      ) : null}

      <div className="flex items-center justify-between gap-3 text-xs">
        <Link href="/rooms" className="text-neutral-400 underline-offset-2 hover:text-neutral-200 hover:underline">
          Go to your rooms
        </Link>
        {wrongAccount ? (
          // Signing out is a POST so it cannot be triggered cross-site.
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="text-neutral-400 underline-offset-2 hover:text-neutral-200 hover:underline"
            >
              Sign out and switch account
            </button>
          </form>
        ) : null}
      </div>
    </div>
  )
}
