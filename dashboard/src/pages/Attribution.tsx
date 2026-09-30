// Where installs came from, as Apple reports it: the postbacks an ad's
// winning network gets (copies of them), and App Store Connect's campaign
// reports. Both aggregate: no row here is a person or an install.
import { useState } from 'react'

import { Segmented } from '@/components/Segmented'
import { useApi } from '@/lib/data'
import { num, when } from '@/lib/format'
import { money } from '@/lib/money'
import { usePrefs } from '@/lib/session'

type Milestone = { value: number; coarse: 'low' | 'medium' | 'high'; event: string; where: Record<string, string> | null; label: string; lock: boolean }
type Attribution = {
  app_store_id: string | null
  conversion_values: Milestone[]
  postbacks: {
    campaigns: { kind: 'skan' | 'aak'; ad_network: string | null; source_identifier: string | null; installs: number; redownloads: number; views: number; last: string }[]
    values: { sequence: number; conversion_value: number | null; coarse_value: string | null; n: number }[]
    unverified: number
  }
  appstore: {
    configured: boolean
    request: { created_at: string; last_sync: string | null; last_error: string | null } | null
    latest_day: string | null
    campaigns: Record<string, number | string>[]
  }
}

/** A conversion value as the catalog names it: the highest milestone at or under it. */
const milestone = (list: Milestone[], v: number | null) => {
  if (v == null) return null
  if (v === 0) return 'Installed'
  return [...list].reverse().find((m) => m.value <= v)?.label ?? `Value ${v}`
}

const NETWORKS: Record<string, string> = {
  'v9wttpbfk9.skadnetwork': 'Meta',
  'n38lu8286q.skadnetwork': 'Meta',
  'cstr6suwn9.skadnetwork': 'Google',
  'development.adattributionkit': 'Apple test',
  'com.example': 'Apple sample',
}
const network = (id: string | null) => (id ? (NETWORKS[id.toLowerCase()] ?? id) : 'unknown')

const th = 'px-3 py-2 text-right font-medium first:pl-0 first:text-left'
const td = 'px-3 py-2 text-right tabular-nums first:pl-0 first:text-left'
const lth = 'px-3 py-2 text-left font-medium first:pl-0'
const ltd = 'px-3 py-2 text-left tabular-nums first:pl-0'

function Postbacks({ a }: { a: Attribution }) {
  const { campaigns, values, unverified } = a.postbacks
  const firsts = values.filter((v) => v.sequence === 0)
  const total = firsts.reduce((n, v) => n + v.n, 0)
  if (!campaigns.length)
    return (
      <p className="text-sm text-muted-foreground">
        No postbacks in this period. The app's Info.plist sends copies to hush's domain (NSAdvertisingAttributionReportEndpoint, AdAttributionKit
        AttributionCopyEndpoint), and each arrives a day or two after an ad's install window closes.
        {unverified > 0 && ` ${unverified} arrived that did not verify with Apple's keys, and are not counted.`}
      </p>
    )
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th className={th}>Network · campaign</th>
              <th className={th}>Installs</th>
              <th className={th}>Redownloads</th>
              <th className={th}>From a view</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={`${c.kind}-${c.ad_network}-${c.source_identifier}`} className="border-b last:border-0">
                <td className={td}>
                  <span className="font-medium">{network(c.ad_network)}</span>{' '}
                  <span className="font-mono text-xs text-muted-foreground">
                    {c.source_identifier ?? '–'} · {c.kind === 'aak' ? 'AdAttributionKit' : 'SKAdNetwork'}
                  </span>
                </td>
                <td className={td}>{num(c.installs)}</td>
                <td className={td}>{num(c.redownloads)}</td>
                <td className={td}>{num(c.views)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {unverified > 0 && <p className="mt-2 text-xs text-muted-foreground">{unverified} more did not verify with Apple's keys and are not counted.</p>}
      </div>
      <div>
        <div className="mb-2 text-xs text-muted-foreground">How far those installs got in the first window (days 0 to 2)</div>
        <ol className="flex flex-col gap-2">
          {firsts.map((v) => {
            const label = v.conversion_value != null ? milestone(a.conversion_values, v.conversion_value) : v.coarse_value ? `${v.coarse_value} (coarse)` : 'Not reported (small campaign)'
            return (
              <li key={`${v.conversion_value}-${v.coarse_value}`}>
                <div className="mb-1 flex justify-between text-sm">
                  <span>
                    {label}
                    {v.conversion_value != null && <span className="ml-1.5 font-mono text-xs text-muted-foreground">{v.conversion_value}</span>}
                  </span>
                  <span className="tabular-nums">{num(v.n)}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(1, (v.n / (total || 1)) * 100)}%` }} />
                </div>
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}

const STORE_COLUMNS: [string, string, 'n' | 'usd'][] = [
  ['impressions', 'Impressions', 'n'],
  ['page_views', 'Page views', 'n'],
  ['first_downloads', 'First downloads', 'n'],
  ['redownloads', 'Redownloads', 'n'],
  ['sessions', 'Sessions', 'n'],
  ['purchases', 'Purchases', 'n'],
  ['proceeds_usd', 'Proceeds', 'usd'],
]

function StoreCampaigns({ a }: { a: Attribution }) {
  const s = a.appstore
  if (!a.app_store_id) return <p className="text-sm text-muted-foreground">Add the app's app_store_id to the catalog to read its App Store campaigns.</p>
  if (!s.configured && !s.campaigns.length) return <p className="text-sm text-muted-foreground">Set ASC_KEY_ID, ASC_ISSUER_ID and ASC_PRIVATE_KEY on the server to import App Store Connect's campaign reports.</p>
  if (s.request?.last_error) return <p className="text-sm text-destructive">App Store Connect: {s.request.last_error}</p>
  if (!s.campaigns.length)
    return (
      <p className="text-sm text-muted-foreground">
        {s.request ? `Report request made ${when(s.request.created_at)}; Apple has the first data a day or two later.` : 'Waiting for the first sync.'} Campaigns
        show once they have five first-time downloads.
      </p>
    )
  const cols = STORE_COLUMNS.filter(([k]) => s.campaigns.some((c) => c[k] != null))
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="border-b text-xs text-muted-foreground">
            <th className={th}>Campaign (ct)</th>
            {cols.map(([k, label]) => (
              <th key={k} className={th}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {s.campaigns.map((c) => (
            <tr key={String(c.campaign)} className="border-b last:border-0">
              <td className={td}>{c.campaign ? <span className="font-medium">{String(c.campaign)}</span> : <span className="text-muted-foreground italic">no campaign</span>}</td>
              {cols.map(([k, , unit]) => (
                <td key={k} className={td}>
                  {c[k] == null ? '–' : unit === 'usd' ? money(Math.round(Number(c[k])), '$', 'USD') : num(Number(c[k]))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted-foreground">
        Apple's numbers through {s.latest_day ?? '–'}, synced {when(s.request?.last_sync)}: users who share analytics with developers, under five hidden, with noise
        added.
      </p>
    </div>
  )
}

function Schema({ list }: { list: Milestone[] }) {
  if (!list.length)
    return <p className="text-sm text-muted-foreground">No conversion values in the catalog: postbacks will carry 0 (installed) and nothing more.</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-xs text-muted-foreground">
            <th className={lth}>Fine</th>
            <th className={lth}>Coarse</th>
            <th className={lth}>Milestone</th>
            <th className={lth}>Event</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b">
            <td className={ltd}>0</td>
            <td className={ltd}>low</td>
            <td className={ltd}>Installed</td>
            <td className={ltd}>
              <span className="font-mono text-xs">first launch</span>
            </td>
          </tr>
          {list.map((m) => (
            <tr key={m.value} className="border-b last:border-0">
              <td className={ltd}>{m.value}</td>
              <td className={ltd}>{m.coarse}</td>
              <td className={ltd}>
                {m.label}
                {m.lock && <span className="ml-1.5 text-xs text-muted-foreground">(ends the window)</span>}
              </td>
              <td className={ltd}>
                <span className="font-mono text-xs">
                  {m.event}
                  {m.where && ` ${Object.entries(m.where).map(([k, v]) => `${k}=${v}`).join(' ')}`}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted-foreground">
        The SDK sets these as they happen, and never lowers one. Enter the same table in the ad network (Meta: Events Manager, the app, SKAdNetwork, with "SKAdNetwork for
        Facebook SDK" off) so it reads the values the way hush does.
      </p>
    </div>
  )
}

export function AttributionPanel({ slug }: { slug: string }) {
  const { prefs } = usePrefs()
  const { data } = useApi<Attribution>(`/admin/apps/${encodeURIComponent(slug)}/attribution?days=${prefs.days}&env=${prefs.env}`)
  const [view, setView] = useState<'ads' | 'store' | 'values'>('ads')
  if (!data) return <div className="h-32" />
  return (
    <div className="flex flex-col gap-4">
      <Segmented
        label="Source"
        value={view}
        onChange={setView}
        options={[
          { value: 'ads', label: 'Ad postbacks' },
          { value: 'store', label: 'App Store campaigns' },
          { value: 'values', label: `Conversion values${data.conversion_values.length ? ` (${data.conversion_values.length})` : ''}` },
        ]}
        className="self-start"
      />
      {view === 'ads' && <Postbacks a={data} />}
      {view === 'store' && <StoreCampaigns a={data} />}
      {view === 'values' && <Schema list={data.conversion_values} />}
      {prefs.env === 'dev' && view === 'ads' && <p className="text-xs text-muted-foreground">Dev shows Apple's test postbacks (the developer tool), never real ones.</p>}
    </div>
  )
}

