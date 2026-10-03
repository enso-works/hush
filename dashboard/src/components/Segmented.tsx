import { cn } from '@/lib/utils'

/** A small segmented control: one of a few options, all visible. */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  label: string
  className?: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex h-8 items-center rounded-lg bg-muted p-0.5 text-sm', className)}>
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'h-7 rounded-md px-2.5 font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-60',
              active && 'bg-card text-foreground shadow-sm ring-1 ring-border',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
