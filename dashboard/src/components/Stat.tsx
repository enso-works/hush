import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'

import { NumberTicker } from '@/components/ui/number-ticker'
import { change } from '@/lib/format'
import { cn } from '@/lib/utils'

export function Delta({ now, before, className }: { now: number; before?: number; className?: string }) {
  if (before === undefined) return null
  const c = change(now, before)
  if (c === null)
    return <span className={cn('text-xs font-medium text-muted-foreground', className)}>{now ? 'new' : '–'}</span>
  const Icon = c > 0 ? ArrowUpRight : c < 0 ? ArrowDownRight : Minus
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium tabular-nums',
        c > 0 && 'bg-good/10 text-good',
        c < 0 && 'bg-bad/10 text-bad',
        c === 0 && 'bg-muted text-muted-foreground',
        className,
      )}
    >
      <Icon className="size-3" aria-hidden />
      {c > 0 ? '+' : ''}
      {c}%
    </span>
  )
}

/** A number that matters, how it moved against the prior period, and what it is. */
export function Stat({
  label,
  value,
  before,
  text,
  hint,
}: {
  label: string
  value: number
  before?: number
  /** Shown instead of the animated number (a percentage, say). */
  text?: string
  hint?: string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-4">
      <div className="truncate text-xs font-medium text-muted-foreground first-letter:uppercase" title={label}>
        {label}
      </div>
      <div className="flex items-end justify-between gap-2">
        <div className="text-2xl font-semibold tracking-tight tabular-nums">
          {text ?? (value > 0 ? <NumberTicker value={value} className="tracking-tight text-foreground dark:text-foreground" /> : '0')}
        </div>
        <Delta now={value} before={before} />
      </div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  )
}
