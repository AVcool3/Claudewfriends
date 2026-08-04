import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import LoginForm from '@/app/login/LoginForm'
import { getSessionUser } from '@/lib/supabase/server'

export const metadata: Metadata = {
  title: 'Sign in · Collaborative Claude',
}

/**
 * Only same-origin, non-protocol-relative paths may be used as a post-login
 * destination. `//evil.example` and `/\evil.example` are both read as absolute
 * URLs by browsers, so a bare "starts with /" test is not enough.
 */
function safeNext(value: string | undefined): string | null {
  if (!value) return null
  if (!value.startsWith('/')) return null
  if (value.startsWith('//') || value.startsWith('/\\')) return null
  return value
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const next = safeNext(firstParam(params.next))
  const error = firstParam(params.error) ?? null

  const user = await getSessionUser()
  if (user) redirect(next ?? '/rooms')

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-lg font-semibold tracking-tight text-neutral-100">Collaborative Claude</h1>
          <p className="mt-1 text-sm text-neutral-500">
            One Claude conversation, shared by a room of approved people.
          </p>
        </div>
        <LoginForm next={next} initialError={error} />
      </div>
    </main>
  )
}
