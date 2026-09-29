import type { ReactNode } from 'react'

import { Segmented } from '@/components/Segmented'
import { usePrefs } from '@/lib/session'

export function PageHeader({ title, sub, icon, actions }: { title: ReactNode; sub?: ReactNode; icon?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        {icon}
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
          {sub && <p className="mt-0.5 text-sm text-muted-foreground">{sub}</p>}
        </div>
      </div>
      {actions}
    </div>
  )
}

export function PeriodControls() {
  const { prefs, setPrefs } = usePrefs()
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented
        label="Period"
        value={prefs.days}
        onChange={(days) => setPrefs({ days })}
        options={[
          { value: 7, label: '7d' },
          { value: 30, label: '30d' },
          { value: 90, label: '90d' },
          { value: 365, label: '1y' },
        ]}
      />
      <Segmented
        label="Environment"
        value={prefs.env}
        onChange={(env) => setPrefs({ env })}
        options={[
          { value: 'prod', label: 'Prod' },
          { value: 'dev', label: 'Dev' },
        ]}
      />
    </div>
  )
}
