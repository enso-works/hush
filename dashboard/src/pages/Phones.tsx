// The hush app on phones: a QR code that signs one in, and the phones signed
// in, each revocable on its own. The QR code holds a pairing code
// (src/devices.mjs: single use, ten minutes), never the admin token, which a
// dashboard signed in by a proxy does not even have. On the demo it holds the
// address alone: the demo needs no code.
import { useEffect, useState } from 'react'
import { RefreshCw, Smartphone, Trash2 } from 'lucide-react'

import { PageHeader } from '@/components/PageHeader'
import { QrCode } from '@/components/QrCode'
import { Button } from '@/components/ui/button'
import { api, type Device, type Pairing } from '@/lib/api'
import { useApi } from '@/lib/data'
import { stamp, when } from '@/lib/format'
import { pairingLink, serverUrl } from '@/lib/pairing'
import { useSession } from '@/lib/session'
import { ErrorNote } from '@/pages/ErrorNote'

function Countdown({ until, onOver }: { until: string; onOver: () => void }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const left = Math.max(0, Math.round((Date.parse(until) - now) / 1000))
  useEffect(() => {
    if (left === 0) onOver()
  }, [left, onOver])
  return (
    <span className="tabular-nums">
      {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
    </span>
  )
}

function Connect({ onPaired }: { onPaired: () => void }) {
  const { demo } = useSession()
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const show = async () => {
    setBusy(true)
    setError(null)
    try {
      setPairing(await api<Pairing>('/admin/pairing', { method: 'POST' }))
    } catch (e) {
      setError(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  // A code is single use: once a phone has it, the list below has the phone.
  useEffect(() => {
    if (!pairing) return
    const t = setInterval(() => document.visibilityState === 'visible' && onPaired(), 4000)
    return () => clearInterval(t)
  }, [pairing, onPaired])

  const link = demo ? pairingLink(serverUrl()) : pairing ? pairingLink(serverUrl(), pairing.code) : null

  return (
    <section className="rounded-xl border bg-card p-5">
      <h2 className="font-semibold">Connect a phone</h2>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        Scan the code with the iPhone's camera, or in the hush app with Add server, Scan QR code. The phone gets a token of its own, which you can revoke
        below; the admin token stays on the server.
      </p>
      {error && <ErrorNote message={error} />}
      <div className="mt-5 flex flex-wrap items-start gap-6">
        {link ? (
          <QrCode text={link} label="QR code that signs the hush app in to this server" className="size-56 rounded-lg ring-1 ring-foreground/10" />
        ) : (
          <div className="grid size-56 place-items-center rounded-lg border border-dashed">
            <Button onClick={show} disabled={busy}>
              <Smartphone className="size-4" aria-hidden /> Show QR code
            </Button>
          </div>
        )}
        <div className="flex max-w-sm flex-col gap-3 text-sm">
          {demo ? (
            <p className="text-muted-foreground">The demo needs no code: this one holds its address only.</p>
          ) : pairing ? (
            <>
              <p>
                Expires in <Countdown until={pairing.expires_at} onOver={() => setPairing(null)} />, or once a phone has used it.
              </p>
              <p className="text-muted-foreground">Anyone who scans it before then can sign in. Show it only to your own phone.</p>
              <Button variant="outline" className="self-start" onClick={show} disabled={busy}>
                <RefreshCw className="size-4" aria-hidden /> New code
              </Button>
            </>
          ) : (
            <p className="text-muted-foreground">Each code works once, for ten minutes.</p>
          )}
          <p className="text-muted-foreground">
            Server address in the code: <span className="font-mono text-xs text-foreground">{serverUrl()}</span>. The phone must reach it, so a server whose
            /admin is on a VPN needs the phone on that VPN.
          </p>
        </div>
      </div>
    </section>
  )
}

function Paired({ devices, reload }: { devices: Device[]; reload: () => void }) {
  const { demo } = useSession()
  const [error, setError] = useState<string | null>(null)
  const revoke = async (d: Device) => {
    if (!confirm(`Revoke "${d.name}"? The app on it is signed out at once; pairing it again needs a new code.`)) return
    try {
      await api(`/admin/devices/${d.id}`, { method: 'DELETE' })
      reload()
    } catch (e) {
      setError(String((e as Error).message))
    }
  }
  return (
    <section className="rounded-xl border bg-card p-5">
      <h2 className="font-semibold">Signed-in phones</h2>
      {error && <ErrorNote message={error} />}
      {devices.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">No phone yet.</p>
      ) : (
        <ul className="mt-3 divide-y">
          {devices.map((d) => (
            <li key={d.id} className="flex items-center gap-3 py-3">
              <Smartphone className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{d.name}</div>
                <div className="text-xs text-muted-foreground">
                  Paired {stamp(d.created_at)} · last seen {when(d.last_seen_at)}
                </div>
              </div>
              {!demo && (
                <Button variant="ghost" size="sm" onClick={() => revoke(d)}>
                  <Trash2 className="size-4" aria-hidden /> Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function Phones() {
  const { data, error, reload } = useApi<{ devices: Device[] }>('/admin/devices')
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Phones" sub="The hush app on iPhone and iPad, signed in to this server" />
      {error && <ErrorNote message={error} />}
      <Connect onPaired={reload} />
      {data && <Paired devices={data.devices} reload={reload} />}
    </div>
  )
}
