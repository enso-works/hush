export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" className={className} aria-hidden>
      <rect x="16" y="16" width="992" height="992" rx="224" fill="var(--brand)" />
      <path
        d="M288 300h448a80 80 0 0 1 80 80v240a80 80 0 0 1-80 80H470l-126 96a14 14 0 0 1-22-11v-85h-34a80 80 0 0 1-80-80V380a80 80 0 0 1 80-80z"
        fill="var(--brand-foreground)"
      />
      <rect x="380" y="486" width="264" height="52" rx="26" fill="var(--brand)" />
    </svg>
  )
}

/** A letter tile for an app, tinted from its slug so each app keeps its colour. */
export function AppMark({ slug, name, className }: { slug: string; name: string; className?: string }) {
  let h = 0
  for (const c of slug) h = (h * 31 + c.charCodeAt(0)) % 360
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-md text-xs font-semibold text-white ${className ?? 'size-6'}`}
      style={{ background: `oklch(0.62 0.16 ${h})` }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}
