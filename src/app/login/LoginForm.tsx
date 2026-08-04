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
  const [githubBusy, setGithubBusy] = useState(false)
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

  /**
   * OAuth is a full-page redirect, so unlike the form paths there is no
   * response to inspect here — success lands on /auth/callback with a code.
   *
   * Note for invited users: an invitation binds to an email address, and
   * GitHub sign-in yields whatever address GitHub exposes. Someone invited at
   * their work email who signs in through a GitHub account registered to a
   * personal one will create a second, uninvited account — hence the caption
   * below the button.
   */
  async function signInWithGithub() {
    setGithubBusy(true)
    setError(null)
    const supabase = createClient()
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'github',
      options: { redirectTo: emailRedirectTo },
    })
    if (oauthError) {
      setError(oauthError.message)
      setGithubBusy(false)
    }
    // On success the browser is navigating away; leaving the spinner running
    // is the honest state.
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

      <div className="mt-4 flex items-center gap-3" aria-hidden="true">
        <div className="h-px flex-1 bg-neutral-800" />
        <span className="text-[11px] uppercase tracking-wide text-neutral-500">or</span>
        <div className="h-px flex-1 bg-neutral-800" />
      </div>

      <Button
        variant="secondary"
        className="mt-4 w-full"
        loading={githubBusy}
        onClick={signInWithGithub}
        aria-label="Continue with GitHub"
      >
        <svg viewBox="0 0 16 16" className="mr-2 h-4 w-4 fill-current" aria-hidden="true">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
        </svg>
        Continue with GitHub
      </Button>

      <p className="mt-4 text-center text-[11px] leading-4 text-neutral-500">
        {mode === 'signin'
          ? 'Invited to a room? Sign in with the address the invitation was sent to — GitHub sign-in only matches if your GitHub email is the invited one.'
          : 'An account on its own grants no access — a Core Prompter still has to invite you to a room.'}
      </p>
    </div>
  )
}
