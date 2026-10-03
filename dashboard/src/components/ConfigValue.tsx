import type { ReactNode } from 'react'

import { formatValue, truncate } from '@/lib/config'
import { cn } from '@/lib/utils'

/** A config value on one line: mono, cut at 60 characters with the whole of it as the title. */
export function ValueText({ value, className }: { value: unknown; className?: string }) {
  const full = formatValue(value)
  return (
    <span className={cn('font-mono text-xs', className)} title={full.length > 60 ? full : undefined}>
      {truncate(full)}
    </span>
  )
}

/** A labelled control with its message under it. `label` is what shows; the control carries its own accessible name. */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
  className,
}: {
  label: ReactNode
  htmlFor?: string
  error?: string
  hint?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
