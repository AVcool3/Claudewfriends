'use client'

import { useCallback, useEffect, useState } from 'react'

import Badge from '@/components/ui/Badge'
import Banner from '@/components/ui/Banner'
import Button from '@/components/ui/Button'
import Spinner from '@/components/ui/Spinner'
import { RepoConnectDialog } from '@/components/repo/RepoConnectDialog'
import type { Capability } from '@/lib/permissions'
import {
  REPO_ACCESS_MODE_LABELS,
  type RepoAccessMode,
  type RepoActionRecord,
  type RepoConnection,
} from '@/lib/types'

interface RepoState {
  configured: boolean
  connection: RepoConnection | null
  actions: RepoActionRecord[]
  can_connect: boolean
  install_url: string | null
}

interface RepoPanelProps {
  roomId: string
  capabilities: Record<Capability, boolean>
}

/**
 * The "connected repository" section of a room. Visible to every member so the
 * whole room can see what Claude can reach; the controls activate only for the
 * Core Prompter (`room.connect_repo`).
 */
export function RepoPanel({ roomId, capabilities }: RepoPanelProps) {
  const [state, setState] = useState<RepoState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/rooms/${roomId}/repo`, {
        headers: { accept: 'application/json' },
      })
      if (!response.ok) {
        setError('Could not load the repository connection.')
        return
      }
      const payload = (await response.json()) as RepoState
      setState(payload)
      setError(null)
    } catch {
      setError('Network error loading the repository connection.')
    }
  }, [roomId])

  useEffect(() => {
    void load()
  }, [load])

  const canManage = capabilities['room.connect_repo']

  async function setAccessMode(mode: RepoAccessMode) {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/rooms/${roomId}/repo`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_mode: mode }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? 'Could not change repository access.')
        return
      }
      await load()
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    if (!window.confirm('Disconnect this repository from the room? Claude will lose access to it.')) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/rooms/${roomId}/repo`, { method: 'DELETE' })
      if (!response.ok) {
        setError('Could not disconnect the repository.')
        return
      }
      await load()
    } finally {
      setBusy(false)
    }
  }

  if (state === null) {
    return (
      <section className="border-t border-neutral-800 px-4 py-4">
        <SectionHeader />
        <div className="flex items-center gap-2 py-3 text-sm text-neutral-500">
          <Spinner size="sm" /> Loading…
        </div>
      </section>
    )
  }

  if (!state.configured) {
    return (
      <section className="border-t border-neutral-800 px-4 py-4">
        <SectionHeader />
        <p className="text-xs leading-5 text-neutral-500">
          GitHub is not configured for this deployment, so repositories cannot be connected.
        </p>
      </section>
    )
  }

  const connection = state.connection

  return (
    <section className="border-t border-neutral-800 px-4 py-4">
      <SectionHeader />

      {error ? (
        <div className="mb-3">
          <Banner tone="error" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        </div>
      ) : null}

      {connection ? (
        <div className="space-y-3">
          <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-3">
            <a
              href={`https://github.com/${connection.owner}/${connection.repo}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-sm text-neutral-100 hover:underline"
            >
              {connection.owner}/{connection.repo}
            </a>
            <div className="mt-1 flex items-center gap-2 text-[11px] text-neutral-500">
              <span>default: {connection.default_branch}</span>
              <Badge tone={connection.access_mode === 'read_pr' ? 'admin' : 'neutral'}>
                {REPO_ACCESS_MODE_LABELS[connection.access_mode]}
              </Badge>
            </div>
          </div>

          {canManage ? (
            <div className="space-y-2">
              <label className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                Access
              </label>
              <div className="flex gap-2">
                <ModeButton
                  active={connection.access_mode === 'read'}
                  disabled={busy}
                  onClick={() => setAccessMode('read')}
                >
                  Read-only
                </ModeButton>
                <ModeButton
                  active={connection.access_mode === 'read_pr'}
                  disabled={busy}
                  onClick={() => setAccessMode('read_pr')}
                >
                  Read + PRs
                </ModeButton>
              </div>
              <p className="text-[11px] leading-4 text-neutral-500">
                Pull requests can only be opened on a turn the Core Prompter sends themselves.
                Collaborator messages never trigger a write.
              </p>
              <div className="flex gap-2 pt-1">
                <Button variant="secondary" size="sm" onClick={() => setDialogOpen(true)} disabled={busy}>
                  Change repository
                </Button>
                <Button variant="danger" size="sm" onClick={disconnect} loading={busy}>
                  Disconnect
                </Button>
              </div>
            </div>
          ) : null}

          {state.actions.length > 0 ? <RepoActivity actions={state.actions} /> : null}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs leading-5 text-neutral-500">
            No repository is connected. Claude answers from the conversation alone.
          </p>
          {canManage ? (
            <Button variant="secondary" size="sm" onClick={() => setDialogOpen(true)}>
              Connect a repository
            </Button>
          ) : (
            <p className="text-[11px] text-neutral-600">
              Only the Core Prompter can connect a repository.
            </p>
          )}
        </div>
      )}

      {dialogOpen ? (
        <RepoConnectDialog
          roomId={roomId}
          installUrl={state.install_url}
          onClose={() => setDialogOpen(false)}
          onConnected={() => {
            setDialogOpen(false)
            void load()
          }}
        />
      ) : null}
    </section>
  )
}

function SectionHeader() {
  return (
    <div className="mb-3 flex items-center gap-2">
      <svg viewBox="0 0 16 16" className="h-4 w-4 fill-neutral-400" aria-hidden="true">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
      </svg>
      <h3 className="text-sm font-semibold text-neutral-200">Repository</h3>
    </div>
  )
}

function ModeButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`flex-1 rounded-md border px-2 py-1.5 text-xs font-medium transition ${
        active
          ? 'border-indigo-500 bg-indigo-500/15 text-indigo-200'
          : 'border-neutral-800 bg-neutral-950 text-neutral-400 hover:border-neutral-700'
      } disabled:opacity-50`}
    >
      {children}
    </button>
  )
}

function RepoActivity({ actions }: { actions: RepoActionRecord[] }) {
  return (
    <div className="pt-1">
      <label className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500">
        Recent activity
      </label>
      <ul className="mt-2 space-y-1.5">
        {actions.slice(0, 8).map((action) => (
          <li key={action.id} className="flex items-start gap-2 text-[11px] leading-4">
            <span
              className={`mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                action.ok ? 'bg-emerald-500' : 'bg-red-500'
              }`}
              aria-hidden="true"
            />
            <span className="text-neutral-400">
              {action.pull_request_url ? (
                <a
                  href={action.pull_request_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-indigo-300 hover:underline"
                >
                  {action.summary}
                </a>
              ) : (
                action.summary || action.tool
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default RepoPanel
