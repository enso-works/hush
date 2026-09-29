// A hash router: the page is served from wherever the proxy mounts it, and a
// hash never reaches the server, so no route needs server support.
import { useEffect, useState } from 'react'

export type Route =
  | { page: 'overview' }
  | { page: 'app'; slug: string }
  | { page: 'feedback'; id?: number; status: string; kind: string }

function parse(hash: string): Route {
  const [path, query] = hash.replace(/^#/, '').split('?')
  const params = new URLSearchParams(query ?? '')
  const parts = path.split('/').filter(Boolean)
  if (parts[0] === 'app' && parts[1]) return { page: 'app', slug: decodeURIComponent(parts[1]) }
  // #/tickets is the old dashboard's name for it; links to it keep working.
  if (parts[0] === 'feedback' || parts[0] === 'tickets') {
    const id = Number(parts[1])
    return {
      page: 'feedback',
      id: Number.isInteger(id) && id > 0 ? id : undefined,
      status: params.get('status') ?? 'open',
      kind: params.get('kind') ?? 'all',
    }
  }
  return { page: 'overview' }
}

export function useRoute() {
  const [route, setRoute] = useState(() => parse(location.hash))
  useEffect(() => {
    const on = () => setRoute(parse(location.hash))
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}

export const href = {
  overview: () => '#/',
  app: (slug: string) => `#/app/${encodeURIComponent(slug)}`,
  feedback: (o: { id?: number; status?: string; kind?: string } = {}) => {
    const q = new URLSearchParams()
    if (o.status && o.status !== 'open') q.set('status', o.status)
    if (o.kind && o.kind !== 'all') q.set('kind', o.kind)
    const qs = q.toString()
    return `#/feedback${o.id ? `/${o.id}` : ''}${qs ? `?${qs}` : ''}`
  },
}
