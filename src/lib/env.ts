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
}
