'use client'

import Avatar from '@/components/ui/Avatar'
import type { Profile } from '@/lib/types'

export interface ProfileCardProps {
  profile: Profile
}

function SignOutIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <path d="M6.5 13.5H3.75A1.25 1.25 0 0 1 2.5 12.25v-8.5A1.25 1.25 0 0 1 3.75 2.5H6.5" />
      <path d="M10.5 11 13.5 8l-3-3" />
      <path d="M13.5 8H6" />
    </svg>
  )
}

export function ProfileCard({ profile }: ProfileCardProps) {
  return (
    <div className="flex items-center gap-2.5 border-t border-neutral-800 px-3 py-3">
      <Avatar name={profile.display_name} src={profile.avatar_url} size="md" />

      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-neutral-100">{profile.display_name}</p>
        <p className="truncate text-[11px] leading-4 text-neutral-500" title={profile.email}>
          {profile.email}
        </p>
      </div>

      {/*
       * A real form posting to /auth/signout, not a fetch: the route is POST-only
       * (a GET sign-out is triggerable by any third-party <img>), and a plain form
       * still signs the user out if the client bundle failed to load.
       */}
      <form action="/auth/signout" method="post" className="shrink-0">
        <button
          type="submit"
          aria-label="Sign out"
          title="Sign out"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-neutral-500 transition-colors hover:border-neutral-700 hover:bg-neutral-800 hover:text-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/60"
        >
          <SignOutIcon />
        </button>
      </form>
    </div>
  )
}

export default ProfileCard
