import { Moon } from 'lucide-react'

import { INACTIVE_DAYS } from '@/lib/apps'
import { cn } from '@/lib/utils'

/** The flag on an app with no events for INACTIVE_DAYS. */
export function InactiveBadge({ className }: { className?: string }) {
  return (
    <span
      title={`No events for ${INACTIVE_DAYS} days`}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-px align-middle text-[11px] font-medium tracking-normal text-muted-foreground',
        className,
      )}
    >
      <Moon className="size-2.5" aria-hidden /> Inactive
    </span>
  )
}
