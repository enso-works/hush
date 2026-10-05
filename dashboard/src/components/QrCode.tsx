// A QR code as one SVG path, drawn from uqr's module grid: no canvas, no
// injected markup or style, so it renders under the dashboard's strict CSP.
// Always dark on white, with the four-module quiet zone scanners expect: an
// inverted code in dark mode is one many cameras will not read.
import { useMemo } from 'react'
import { encode } from 'uqr'

export function QrCode({ text, label, className }: { text: string; label: string; className?: string }) {
  const { size, d } = useMemo(() => {
    const { size, data } = encode(text, { ecc: 'M', border: 0 })
    let d = ''
    data.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x + 4} ${y + 4}h1v1h-1z`)))
    return { size: size + 8, d }
  }, [text])
  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} className={className} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  )
}
