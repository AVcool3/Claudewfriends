'use client'

import { useCallback, useEffect, useState } from 'react'

import Banner from '@/components/ui/Banner'
import Button from '@/components/ui/Button'
import { Field, Select } from '@/components/ui/Field'
import { Modal } from '@/components/ui/Modal'
import Spinner from '@/components/ui/Spinner'
import { REPO_ACCESS_MODES, type RepoAccessMode } from '@/lib/types'

interface RepoOption {
  owner: string
  repo: string
  full_name: string
  default_branch: string
  private: boolean
}

interface InstallationOption {
  installation_id: number
  account_login: string
  account_type: string
  suspended: boolean
  repositories: RepoOption[]
  error: string | null
}

interface InstallationsResponse {
  configured: boolean
  installations: InstallationOption[]
  install_url: string | null
}

interface RepoConnectDialogProps {
  roomId: string
  installUrl: string | null
  onClose: () => void
  onConnected: () => void
}

/**
 * Connect flow. The user picks from repositories their own GitHub App
 * installations expose — the list is fetched live, so it can only ever contain
 * repos GitHub has granted the app. There is no free-text repo field: that
 * would invite a request for a repo the installation cannot reach, which the
 * server would reject anyway.
 */
export function RepoConnectDialog({ roomId, installUrl, onClose, onConnected }: RepoConnectDialogProps) {
  const [data, setData] = useState<InstallationsResponse | null>(null)
  const [selectedKey, setSelectedKey] = useState<string>('')
  const [accessMode, setAccessMode] = useState<RepoAccessMode>('read')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/github/installations', {
        headers: { accept: 'application/json' },
      })
      if (!response.ok) {
        setError('Could not load your GitHub installations.')
        return
      }
      setData((await response.json()) as InstallationsResponse)
    } catch {
      setError('Network error loading GitHub installations.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Flatten every installation's repos into one selectable list, tagged with
  // the installation id the connect call needs.
  const options = (data?.installations ?? []).flatMap((installation) =>
    installation.repositories.map((repo) => ({
      key: `${installation.installation_id}:${repo.full_name}`,
      installationId: installation.installation_id,
      repo,
    })),
  )

  const selected = options.find((option) => option.key === selectedKey) ?? null

  async function connect() {
    if (!selected) {
      setError('Choose a repository first.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/rooms/${roomId}/repo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installation_id: selected.installationId,
          owner: selected.repo.owner,
          repo: selected.repo.repo,
          access_mode: accessMode,
        }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? 'Could not connect the repository.')
        return
      }
      onConnected()
    } catch {
      setError('Network error while connecting the repository.')
    } finally {
      setBusy(false)
    }
  }

  const noInstallations = data !== null && options.length === 0

  return (
    <Modal
      open
      title="Connect a repository"
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={connect} loading={busy} disabled={!selected}>
            Connect
          </Button>
        </div>
      }
    >
      {error ? (
        <div className="mb-3">
          <Banner tone="error" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        </div>
      ) : null}

      {data === null ? (
        <div className="flex items-center gap-2 py-4 text-sm text-neutral-400">
          <Spinner size="sm" /> Loading your GitHub repositories…
        </div>
      ) : noInstallations ? (
        <div className="space-y-3 py-2 text-sm text-neutral-400">
          <p>
            No repositories are available yet. Install the GitHub App on the repositories you want
            this room to reach, then come back here.
          </p>
          {installUrl ? (
            <Button
              variant="secondary"
              onClick={() => window.open(`${installUrl}?state=${roomId}`, '_blank', 'noreferrer')}
            >
              Install the GitHub App
            </Button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setData(null)
              void load()
            }}
            className="block text-xs text-indigo-300 hover:underline"
          >
            I&apos;ve installed it — refresh
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <Field label="Repository" htmlFor="repo-select">
            <Select
              id="repo-select"
              value={selectedKey}
              onChange={(event) => setSelectedKey(event.target.value)}
            >
              <option value="">Choose a repository…</option>
              {data.installations.map((installation) => (
                <optgroup key={installation.installation_id} label={installation.account_login}>
                  {installation.repositories.map((repo) => (
                    <option
                      key={`${installation.installation_id}:${repo.full_name}`}
                      value={`${installation.installation_id}:${repo.full_name}`}
                    >
                      {repo.full_name}
                      {repo.private ? ' (private)' : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>

          <Field
            label="Access"
            htmlFor="access-select"
            hint="Read-only lets Claude browse and cite the code. Read + PRs also lets the Core Prompter have Claude open pull requests — never a direct push to the default branch."
          >
            <Select
              id="access-select"
              value={accessMode}
              onChange={(event) => setAccessMode(event.target.value as RepoAccessMode)}
            >
              {REPO_ACCESS_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {mode === 'read' ? 'Read-only' : 'Read and open pull requests'}
                </option>
              ))}
            </Select>
          </Field>

          {installUrl ? (
            <p className="text-[11px] leading-4 text-neutral-500">
              Missing a repository?{' '}
              <a
                href={`${installUrl}?state=${roomId}`}
                target="_blank"
                rel="noreferrer"
                className="text-indigo-300 hover:underline"
              >
                Adjust which repositories the app can access
              </a>
              .
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  )
}

export default RepoConnectDialog
