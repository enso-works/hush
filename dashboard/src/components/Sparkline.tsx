import { useId } from 'react'
import { Area, AreaChart, ResponsiveContainer } from 'recharts'

export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  const data = values.map((v, i) => ({ i, v }))
  return (
    <div className={className} aria-hidden>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 240, height: 48 }}>
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--brand)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--brand)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area type="monotone" dataKey="v" stroke="var(--brand)" strokeWidth={1.5} fill={`url(#spark-${id})`} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
