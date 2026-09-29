import { useCallback, useEffect, useRef, useState } from 'react'

import { api, AuthError } from './api'
import { useSession } from './session'

type State<T> = { data: T | null; error: string | null; loading: boolean }

/** GET a path; refetches when the path changes, keeps the last data while it does. */
export function useApi<T>(path: string | null) {
  const { signOut } = useSession()
  const [state, setState] = useState<State<T>>({ data: null, error: null, loading: !!path })
  const [nonce, setNonce] = useState(0)
  const current = useRef(path)
  current.current = path

  useEffect(() => {
    if (!path) return
    let live = true
    setState((s) => ({ ...s, loading: true, error: null }))
    api<T>(path)
      .then((data) => live && setState({ data, error: null, loading: false }))
      .catch((err) => {
        if (!live) return
        if (err instanceof AuthError) return signOut('That token was not accepted.')
        setState((s) => ({ ...s, error: String(err.message ?? err), loading: false }))
      })
    return () => {
      live = false
    }
  }, [path, nonce, signOut])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { ...state, reload }
}
