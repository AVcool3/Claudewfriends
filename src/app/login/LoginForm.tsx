'use client'

import { useMemo, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import Banner from '@/components/ui/Banner'
import Button from '@/components/ui/Button'
import { Field, TextInput } from '@/components/ui/Field'
import { publicEnv } from '@/lib/env'
import { createClient } from '@/lib/supabase/client'
import { MAX_DISPLAY_NAME_LENGTH } from '@/lib/types'

type Mode = 'signin' | 'signup' | 'magic'

const MODE_LABELS: Record<Mode, string> = {
  signin: 'Sign in',
  signup: 'Create account',
  magic: 'Magic link',
}

const MIN_PASSWORD_LENGTH = 8

export interface LoginFormProps {
  /** Already validated as a same-origin path by the page. */
  next: string | null
  initialError?: string | null
}

export default function LoginForm({ next, initialError = null }: LoginFormProps) {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(initialError)
  const [sentTo, setSentTo] = useState<string | null>(null)

  /**
   * Supabase sends the user back here with a `code`. The destination has to be
   * an absolute URL registered in the project's redirect allow-list, which is
   * why it comes from NEXT_PUBLIC_SITE_URL rather than window.location.
   */
  const emailRedirectTo = useMemo(() => {
    const base = publicEnv.siteUrl.replace(/\/+$/, '')
    const suffix = next ? `?next=${encodeURIComponent(next)}` : ''
    return `${base}/auth/callback${suffix}`
  }, [next])

  function switchMode(nextMode: Mode) {
    setMode(nextMode)
    setError(null)
    setSentTo(null)
  }

  function landAfterSignIn() {
    router.replace(next ?? '/rooms')
    // The server components above this page were rendered for a signed-out
    // visitor; without a refresh they would be served from the router cache.
    router.refresh()
  }

  function validate(): string | null {
    const trimmedEmail = email.trim()
    if (!trimmedEmail || !trimmedEmail.includes('@')) return 'Enter a valid email address.'
    if (mode !== 'magic' && password.length < MIN_PASSWORD_LENGTH) {
      return `Passwords must be at least ${MIN_PASSWORD_LENGTH} characters.`
    }
    if (mode === 'signup' && displayName.trim().length === 0) {
      return 'Choose a display name — collaborators see it on every contribution.'
    }
    return null
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return

    const problem = validate()
    if (problem) {
      setError(problem)
      return
    }

    setBusy(true)
    setError(null)
    setSentTo(null)

    const supabase = createClient()
    // Supabase lower-cases addresses internally and the invitation check
    // compares lower-cased emails, so normalise here to keep them aligned.
    const address = email.trim().toLowerCase()

    try {
      if (mode === 'signin') {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: address,
          password,
        })
        if (signInError) {
          setError(signInError.message)
          return
        }
        landAfterSignIn()
        return
      }

      if (mode === 'signup') {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: address,
          password,
          options: {
            // Picked up by the handle_new_user trigger to seed profiles.display_name.
            data: { display_name: displayName.trim().slice(0, MAX_DISPLAY_NAME_LENGTH) },
            emailRedirectTo,
          },
        })
        if (signUpError) {
          setError(signUpError.message)
          return
        }
        if (data.session) {
          landAfterSignIn()
          return
        }
        // No session means the project requires email confirmation first.
        setSentTo(address)
        return
      }

      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: address,
        options: { emailRedirectTo },
      })
      if (otpError) {
        setError(otpError.message)
        return
      }
      setSentTo(address)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong. Try again.')
    } finally {
      setBusy(false)
    }
  }

  if (sentTo) {
    return (
      <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <Banner tone="success" title="Check your inbox">
          We sent a link to <span className="font-medium">{sentTo}</span>. Open it in this browser to
          finish signing in. The link expires shortly, and it only works once.
        </Banner>
        <div className="mt-4 flex items-center justify-between gap-2">
          <p className="text-xs text-neutral-500">No email after a minute? Check spam.</p>
          <Button variant="ghost" size="sm" onClick={() => setSentTo(null)}>
            Use a different address
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5 shadow-xl shadow-black/30">
      <div
        role="group"
        aria-label="Sign-in method"
        className="mb-5 grid grid-cols-3 gap-1 rounded-lg bg-neutral-950 p-1"
      >
        {(Object.keys(MODE_LABELS) as Mode[]).map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-pressed={mode === candidate}
            onClick={() => switchMode(candidate)}
            className={`rounded-md px-2 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/60 ${
              mode === candidate
                ? 'bg-neutral-800 text-neutral-100'
                : 'text-neutral-500 hover:text-neutral-300'
            }`}
          >
            {MODE_LABELS[candidate]}
          </button>
        ))}
      </div>

      {error ? (
        <div className="mb-4">
          <Banner tone="error" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        </div>
      ) : null}

      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Field
          label="Email"
          htmlFor="login-email"
          hint={mode === 'magic' ? 'We email you a one-time link — no password needed.' : undefined}
        >
          <TextInput
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            disabled={busy}
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>

        {mode === 'signup' ? (
          <Field
            label="Display name"
            htmlFor="login-name"
            hint="Shown next to every contribution you make."
          >
            <TextInput
              name="displayName"
              autoComplete="name"
              maxLength={MAX_DISPLAY_NAME_LENGTH}
              required
              disabled={busy}
              placeholder="Ada Lovelace"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </Field>
        ) : null}

        {mode !== 'magic' ? (
          <Field
            label="Password"
            htmlFor="login-password"
            hint={mode === 'signup' ? `At least ${MIN_PASSWORD_LENGTH} characters.` : undefined}
          >
            <TextInput
              name="password"
              type="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              required
              disabled={busy}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        ) : null}

        <Button type="submit" loading={busy} className="mt-1 w-full">
          {mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Email me a link'}
        </Button>
      </form>

      <p className="mt-4 text-center text-[11px] leading-4 text-neutral-500">
        {mode === 'signin'
          ? 'Invited to a room? Sign in with the address the invitation was sent to.'
          : 'An account on its own grants no access — a Core Prompter still has to invite you to a room.'}
      </p>
    </div>
  )
}
