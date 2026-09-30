// Campaigns: where tagged links (an ad, a newsletter) brought people, and how
// far they got. First touch per install, from the link's own tags; nothing
// from the ad network, no click ids, no fingerprinting.
import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

import { Segmented } from '@/components/Segmented'
import type { Funnel } from '@/lib/api'
import { useApi } from '@/lib/data'
import { humanize, num, pct } from '@/lib/format'
import { usePrefs } from '@/lib/session'
import { cn } from '@/lib/utils'

type Row = { value: string; installs: number; new: number; steps: number[] }
type Answer = { by: string; window_days: number; steps: { event: string; label: string }[]; rows: Row[] }

const BY = [
  { value: 'utm_source', label: 'Source' },
  { value: 'utm_campaign', label: 'Campaign' },
  { value: 'utm_term', label: 'Ad set' },
  { value: 'utm_content', label: 'Ad' },
] as const

/** What to paste into a Meta ad's URL parameters, so every click says which campaign, ad set and ad it came from. */
const META_PARAMS =
  'utm_source=meta&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_term={{adset.name}}&utm_content={{ad.name}}'

const selectClass =
  'h-8 min-w-0 rounded-md border bg-card px-2 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'

const scope = (prefs: { days: number; env: string; channel: string | null }) =>
  `days=${prefs.days}&env=${prefs.env}${prefs.channel ? `&channel=${encodeURIComponent(prefs.channel)}` : ''}`

function CopyParams() {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(META_PARAMS).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        })
      }}
      className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
      title={META_PARAMS}
    >
      {done ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />} Meta URL parameters
    </button>
  )
}

export function Campaigns({ slug }: { slug: string }) {
  const { prefs } = usePrefs()
  const app = encodeURIComponent(slug)
  const [by, setBy] = useState<(typeof BY)[number]['value']>('utm_campaign')
  const [source, setSource] = useState('')
  const [funnel, setFunnel] = useState(0)
  const funnels = useApi<{ funnels: Funnel[] }>(`/admin/apps/${app}/funnels?${scope(prefs)}`).data?.funnels ?? []
  const sources = useApi<Answer>(`/admin/apps/${app}/campaigns?${scope(prefs)}&by=utm_source&step=session_started`).data?.rows ?? []
  const where = source && by !== 'utm_source' ? `&where=utm_source:${encodeURIComponent(source)}` : ''
  const { data, loading } = useApi<Answer>(`/admin/apps/${app}/campaigns?${scope(prefs)}&by=${by}${where}&funnel=${funnel}`)
  const rows = data?.rows ?? []
  const steps = data?.steps ?? []

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Segmented label="Split by" value={by} onChange={setBy} options={BY.map((b) => ({ value: b.value, label: b.label }))} />
        {by !== 'utm_source' && sources.length > 0 && (
          <select className={selectClass} value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source">
            <option value="">Every source</option>
            {sources.map((s) => (
              <option key={s.value} value={s.value}>
                {s.value}
              </option>
            ))}
          </select>
        )}
        {funnels.length > 1 && (
          <select className={selectClass} value={funnel} onChange={(e) => setFunnel(Number(e.target.value))} aria-label="Funnel">
            {funnels.map((f, i) => (
              <option key={f.name} value={i}>
                {f.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {data && rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No sessions from tagged links in this period. Links need utm_ tags (in a Meta ad: the <CopyParams />), and the app passes the link to{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">entry('link', {'{ url }'})</code>.
        </p>
      ) : (
        <div className={cn('overflow-x-auto', loading && 'opacity-60')}>
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">{BY.find((b) => b.value === by)?.label}</th>
                <th className="px-3 py-2 text-right font-medium">Installs</th>
                <th className="px-3 py-2 text-right font-medium" title="The link brought the install: its first open">
                  New
                </th>
                {steps.map((s, i) => (
                  <th key={`${s.event}-${i}`} className="px-3 py-2 text-right font-medium">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.value} className="border-b last:border-0">
                  <td className="max-w-[16rem] truncate py-2 pr-3 font-medium" title={r.value}>
                    {humanize(r.value)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(r.installs)}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{num(r.new)}</td>
                  {r.steps.map((n, i) => (
                    <td key={i} className="px-3 py-2 text-right tabular-nums">
                      {num(n)} <span className="text-xs text-muted-foreground">{pct(n, r.installs)}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Each install counts once, for its first session from a tagged link in the period, then the funnel's steps in order within{' '}
        {data?.window_days ?? 7} days. On iOS a link only opens an app already installed, so there it measures coming back; new installs from
        an ad are Apple's to count. <CopyParams />
      </p>
    </div>
  )
}
