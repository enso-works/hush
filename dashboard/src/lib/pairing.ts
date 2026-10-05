// What the Phones page's QR code holds: a hush:// link the iPhone's camera
// offers to open in the app, with this server's address and, except on the
// demo, a pairing code (src/devices.mjs).
import { BASE } from './api'

/** Where the app reaches this server: the address this dashboard is served from. */
export const serverUrl = () => new URL(BASE || '/', location.origin).toString().replace(/\/$/, '')

export const pairingLink = (url: string, code?: string) => {
  const q = new URLSearchParams({ url })
  if (code) q.set('code', code)
  return `hush://pair?${q}`
}
