import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import '@/app/globals.css'

export const metadata: Metadata = {
  title: 'Collaborative Claude',
  description:
    'A shared Claude conversation. Collaborators contribute, the Core Prompter owns the thread.',
}

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#0a0a0a',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: extensions and the colour-scheme hint routinely
    // mutate <html> before React hydrates, which is otherwise a noisy mismatch.
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh bg-neutral-950 text-neutral-100 antialiased">{children}</body>
    </html>
  )
}
