/**
 * Centralised environment access.
 *
 * Anything exported from `serverEnv` is a secret. The getter throws if it is
 * ever evaluated in a browser bundle, which turns an accidental client import
 * into a build/runtime error instead of a leaked credential.
 */

function required(name: string, value: string | undefined): string {
  if (!value || value.length === 0) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env.local and fill it in.`,
    )
  }
  return value
}

export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000',
}

export function requirePublicEnv() {
  return {
    supabaseUrl: required('NEXT_PUBLIC_SUPABASE_URL', publicEnv.supabaseUrl),
    supabaseAnonKey: required('NEXT_PUBLIC_SUPABASE_ANON_KEY', publicEnv.supabaseAnonKey),
    siteUrl: publicEnv.siteUrl,
  }
}

function assertServer(name: string) {
  if (typeof window !== 'undefined') {
    throw new Error(
      `${name} was read in a browser context. Server-only secrets must never reach the client bundle.`,
    )
  }
}

export const serverEnv = {
  get supabaseServiceRoleKey(): string {
    assertServer('SUPABASE_SERVICE_ROLE_KEY')
    return required('SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY)
  },
  get anthropicApiKey(): string {
    assertServer('ANTHROPIC_API_KEY')
    return required('ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY)
  },
  get claudeModel(): string {
    return process.env.CLAUDE_MODEL ?? 'claude-opus-5'
  },
  get claudeMaxTokens(): number {
    const parsed = Number.parseInt(process.env.CLAUDE_MAX_TOKENS ?? '', 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 16000
  },
  get claudeEffort(): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
    const value = process.env.CLAUDE_EFFORT
    if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') {
      return value
    }
    return 'high'
  },

  // --- GitHub App -----------------------------------------------------------
  // The app authenticates as an *installation*, never as a user: a signed JWT is
  // exchanged for a token that lives one hour and reaches only the repositories
  // the installer selected. Nothing long-lived is persisted, so revoking access
  // in GitHub's UI takes effect within the hour with no cleanup on our side.
  get githubAppId(): string {
    assertServer('GITHUB_APP_ID')
    return required('GITHUB_APP_ID', process.env.GITHUB_APP_ID)
  },
  get githubAppPrivateKey(): string {
    assertServer('GITHUB_APP_PRIVATE_KEY')
    const raw = required('GITHUB_APP_PRIVATE_KEY', process.env.GITHUB_APP_PRIVATE_KEY)
    // Accepted either as a real PEM (newlines intact), as a PEM with the
    // newlines escaped — which is what most secret managers and .env files do —
    // or base64-encoded, because a PEM pasted into some dashboards loses its
    // line structure entirely.
    if (raw.includes('-----BEGIN')) return raw.replace(/\\n/g, '\n')
    return Buffer.from(raw, 'base64').toString('utf8')
  },
  /** The app's URL slug, used to build the "Install / Configure" link. */
  get githubAppSlug(): string {
    assertServer('GITHUB_APP_SLUG')
    return required('GITHUB_APP_SLUG', process.env.GITHUB_APP_SLUG)
  },
  /** True when the GitHub integration is configured at all. Never throws. */
  get githubConfigured(): boolean {
    if (typeof window !== 'undefined') return false
    return Boolean(
      process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_APP_SLUG,
    )
  },
}
