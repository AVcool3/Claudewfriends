import 'server-only'

import { createSign } from 'node:crypto'

import { serverEnv } from '@/lib/env'

/**
 * GitHub App authentication.
 *
 * Two credentials exist, and the distinction matters:
 *
 *   - The *app JWT* is signed locally with the app's private key. It proves we
 *     are the app and can only reach app-level endpoints (list installations,
 *     mint a token). It cannot read a single line of anyone's code.
 *   - The *installation token* is what actually touches a repository. It is
 *     minted per installation, expires in an hour, and is scoped to exactly the
 *     repositories the installer selected.
 *
 * Neither is ever persisted. Revoking the installation in GitHub's UI ends our
 * access when the cached token expires, with nothing to clean up here.
 */

const GITHUB_API = 'https://api.github.com'
const USER_AGENT = 'collab-claude'

export type GithubErrorCode =
  | 'not_configured'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'validation'
  | 'network'
  | 'unknown'

export class GithubError extends Error {
  readonly code: GithubErrorCode
  readonly status: number
  readonly retryAfterSeconds: number | null

  constructor(
    code: GithubErrorCode,
    message: string,
    options: { status?: number; retryAfterSeconds?: number | null; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'GithubError'
    this.code = code
    this.status = options.status ?? statusForCode(code)
    this.retryAfterSeconds = options.retryAfterSeconds ?? null
  }

  /** True when a retry could plausibly succeed without the caller changing anything. */
  get retryable(): boolean {
    return this.code === 'rate_limited' || this.code === 'network' || this.status >= 500
  }
}

function statusForCode(code: GithubErrorCode): number {
  switch (code) {
    case 'not_configured':
      return 501
    case 'unauthorized':
      return 401
    case 'forbidden':
      return 403
    case 'not_found':
      return 404
    case 'rate_limited':
      return 429
    case 'validation':
      return 422
    default:
      return 502
  }
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Signs the short-lived JWT that identifies this deployment as the app.
 *
 * `iat` is backdated 60 seconds because GitHub rejects a token whose issue time
 * is in the future by even a second, and a server clock running slightly fast is
 * common enough to be worth absorbing. Maximum accepted lifetime is 10 minutes;
 * 9 leaves room for the request itself.
 */
function signAppJwt(): string {
  const now = Math.floor(Date.now() / 1000)
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64Url(
    JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: serverEnv.githubAppId }),
  )
  const signingInput = `${header}.${payload}`

  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  signer.end()

  let signature: Buffer
  try {
    signature = signer.sign(serverEnv.githubAppPrivateKey)
  } catch (error) {
    throw new GithubError(
      'not_configured',
      'The GitHub App private key could not be used to sign a request. Check GITHUB_APP_PRIVATE_KEY is a complete PKCS#1 or PKCS#8 PEM.',
      { cause: error },
    )
  }

  return `${signingInput}.${base64Url(signature)}`
}

interface CachedToken {
  token: string
  expiresAtMs: number
}

/**
 * Installation tokens are cached in memory for the same reason the rate limiter
 * is: this is a single-process default. A second instance simply mints its own
 * token, which is harmless — GitHub issues them freely — so unlike the rate
 * limiter there is nothing here that needs Redis to be correct.
 */
const tokenCache = new Map<number, CachedToken>()

/** Refresh a minute early so a token cannot expire mid-request. */
const TOKEN_SKEW_MS = 60_000

export async function getInstallationToken(installationId: number): Promise<string> {
  if (!serverEnv.githubConfigured) {
    throw new GithubError('not_configured', 'GitHub is not configured for this deployment.')
  }

  const cached = tokenCache.get(installationId)
  if (cached && cached.expiresAtMs - TOKEN_SKEW_MS > Date.now()) {
    return cached.token
  }

  const response = await githubFetch(`/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    token: signAppJwt(),
  })

  const body = (await readJson(response)) as { token?: unknown; expires_at?: unknown }
  if (typeof body.token !== 'string' || typeof body.expires_at !== 'string') {
    throw new GithubError('unknown', 'GitHub returned an installation token in an unexpected shape.')
  }

  tokenCache.set(installationId, {
    token: body.token,
    expiresAtMs: Date.parse(body.expires_at),
  })
  return body.token
}

interface FetchOptions {
  method?: string
  token: string
  body?: unknown
  /** Accept header override, for endpoints that return raw content. */
  accept?: string
}

/**
 * The single place a request leaves for GitHub. Everything funnels through here
 * so status mapping, the user agent and the API version header are consistent.
 */
export async function githubFetch(path: string, options: FetchOptions): Promise<Response> {
  const url = path.startsWith('https://') ? path : `${GITHUB_API}${path}`

  let response: Response
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        authorization: `Bearer ${options.token}`,
        accept: options.accept ?? 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': USER_AGENT,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      // Repository contents change; a cached tree would make Claude reason about
      // a stale checkout.
      cache: 'no-store',
    })
  } catch (error) {
    throw new GithubError('network', 'Could not reach GitHub.', { cause: error })
  }

  if (response.ok) return response

  throw await toGithubError(response)
}

async function toGithubError(response: Response): Promise<GithubError> {
  const detail = await response
    .clone()
    .json()
    .then((body: unknown) =>
      typeof body === 'object' && body !== null && 'message' in body
        ? String((body as { message: unknown }).message)
        : null,
    )
    .catch(() => null)

  const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10)
  const remaining = response.headers.get('x-ratelimit-remaining')

  switch (response.status) {
    case 401:
      return new GithubError('unauthorized', detail ?? 'GitHub rejected our credentials.', {
        status: 401,
      })
    case 403:
      // A 403 with the rate-limit budget at zero is a rate limit wearing a
      // different status code; treating it as a permission failure would send
      // the user hunting for a scope they already have.
      if (remaining === '0') {
        return new GithubError('rate_limited', 'GitHub rate limit reached. Try again shortly.', {
          status: 403,
          retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : 60,
        })
      }
      return new GithubError(
        'forbidden',
        detail ?? 'The GitHub App installation does not grant access to that resource.',
        { status: 403 },
      )
    case 404:
      // GitHub returns 404 rather than 403 for repositories an installation
      // cannot see, so this genuinely means "not found *or* not granted".
      return new GithubError(
        'not_found',
        detail ?? 'That repository or path is not visible to this installation.',
        { status: 404 },
      )
    case 422:
      return new GithubError('validation', detail ?? 'GitHub rejected the request as invalid.', {
        status: 422,
      })
    case 429:
      return new GithubError('rate_limited', 'GitHub rate limit reached. Try again shortly.', {
        status: 429,
        retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : 60,
      })
    default:
      return new GithubError('unknown', detail ?? `GitHub returned ${response.status}.`, {
        status: response.status,
      })
  }
}

export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch (error) {
    throw new GithubError('unknown', 'GitHub returned a response that was not JSON.', {
      cause: error,
    })
  }
}

// ---------------------------------------------------------------------------
// App-level reads (JWT-authenticated)
// ---------------------------------------------------------------------------

export interface InstallationSummary {
  installationId: number
  accountLogin: string
  accountType: string
  suspended: boolean
}

/** Fetches one installation by id, used to verify an install callback. */
export async function fetchInstallation(installationId: number): Promise<InstallationSummary> {
  const response = await githubFetch(`/app/installations/${installationId}`, {
    token: signAppJwt(),
  })
  const body = (await readJson(response)) as {
    id?: unknown
    account?: { login?: unknown; type?: unknown } | null
    suspended_at?: unknown
  }

  if (typeof body.id !== 'number') {
    throw new GithubError('unknown', 'GitHub returned an installation in an unexpected shape.')
  }

  return {
    installationId: body.id,
    accountLogin: typeof body.account?.login === 'string' ? body.account.login : 'unknown',
    accountType: typeof body.account?.type === 'string' ? body.account.type : 'User',
    suspended: typeof body.suspended_at === 'string',
  }
}

export interface RepoSummary {
  owner: string
  repo: string
  fullName: string
  defaultBranch: string
  private: boolean
}

/** Lists the repositories an installation may reach. Paginates to completion. */
export async function listInstallationRepos(installationId: number): Promise<RepoSummary[]> {
  const token = await getInstallationToken(installationId)
  const found: RepoSummary[] = []

  // 100 is GitHub's maximum page size. The cap of 10 pages (1,000 repos) exists
  // so a user installed on an enormous org cannot make this loop run away.
  for (let page = 1; page <= 10; page += 1) {
    const response = await githubFetch(
      `/installation/repositories?per_page=100&page=${page}`,
      { token },
    )
    const body = (await readJson(response)) as { repositories?: unknown }
    const repositories = Array.isArray(body.repositories) ? body.repositories : []

    for (const entry of repositories) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as {
        name?: unknown
        full_name?: unknown
        default_branch?: unknown
        private?: unknown
        owner?: { login?: unknown } | null
      }
      if (typeof record.name !== 'string' || typeof record.owner?.login !== 'string') continue
      found.push({
        owner: record.owner.login,
        repo: record.name,
        fullName:
          typeof record.full_name === 'string' ? record.full_name : `${record.owner.login}/${record.name}`,
        defaultBranch: typeof record.default_branch === 'string' ? record.default_branch : 'main',
        private: record.private === true,
      })
    }

    if (repositories.length < 100) break
  }

  return found
}

/** The URL a user visits to install the app or change which repos it can see. */
export function installationUrl(): string {
  return `https://github.com/apps/${serverEnv.githubAppSlug}/installations/new`
}
