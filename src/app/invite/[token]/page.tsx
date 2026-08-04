import type { Metadata } from 'next'
import Link from 'next/link'
import AcceptInvite from '@/app/invite/[token]/AcceptInvite'
import { getSessionUser } from '@/lib/supabase/server'

export const metadata: Metadata = {
  title: 'Room invitation · Collaborative Claude',
  // A token in the URL should never be handed to a crawler or an index.
  robots: { index: false, follow: false },
}

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  // Next 15 makes route params async; awaiting is mandatory, not stylistic.
  const { token } = await params
  const user = await getSessionUser()

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-xl border border-neutral-800 bg-neutral-900 p-6 shadow-xl shadow-black/30">
        <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">Room invitation</p>
        <h1 className="mt-1 text-lg font-semibold text-neutral-100">You have been invited to a room</h1>

        {user ? (
          /*
           * The invitation row itself is never fetched here or in the client.
           * Its token is a bearer secret and redeeming it is a single
           * server-side transaction, so the page shows no room details until
           * the caller has proved the invitation is theirs.
           */
          <AcceptInvite token={token} signedInEmail={user.email ?? null} />
        ) : (
          <div className="mt-4 space-y-4">
            <p className="text-sm leading-6 text-neutral-400">
              Sign in — or create an account — with the exact email address this invitation was sent
              to. An invitation only redeems for its intended recipient, so a forwarded link will not
              work for anyone else.
            </p>
            <Link
              href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}
              className="inline-flex h-10 w-full items-center justify-center rounded-lg border border-brand-500 bg-brand-500 px-4 text-sm font-medium text-white transition-colors hover:border-brand-400 hover:bg-brand-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-900"
            >
              Continue to sign in
            </Link>
          </div>
        )}
      </div>
    </main>
  )
}
