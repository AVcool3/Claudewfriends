import { redirect } from 'next/navigation'

/**
 * There is no marketing surface — the app is the room list. Unauthenticated
 * visitors are bounced to /login by the middleware before this ever renders.
 */
export default function RootPage() {
  redirect('/rooms')
}
