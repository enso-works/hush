import type { ReactNode } from 'react'

import { num } from '@/lib/format'

/** Rows with a proportional bar behind each: versions, countries, events. */
export function BarList({
  rows,
  empty = 'Nothing yet.',
}: {
  rows: { key: string; label: ReactNode; value: number; extra?: ReactNode }[]
  empty?: string
}) {
  if (!rows.length) return <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <ul className="flex flex-col gap-1">
      {rows.map((r) => (
        <li key={r.key} className="relative flex h-8 items-center justify-between gap-3 overflow-hidden rounded-md px-2.5 text-sm">
          <div
            aria-hidden
            className="absolute inset-y-0 left-0 rounded-md bg-brand/10 dark:bg-brand/15"
            style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }}
          />
          <span className="relative flex min-w-0 items-center gap-2 truncate">{r.label}</span>
          <span className="relative flex shrink-0 items-center gap-3 tabular-nums">
            {r.extra}
            <span className="font-medium">{num(r.value)}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}
