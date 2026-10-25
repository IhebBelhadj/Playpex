import { useMemo } from 'react'
import type { Schemas } from '@/lib/api'
import { cn } from '@/lib/utils'

// The swarm strip (docs/dashboard-plan.md §3.3): a download's progress drawn
// from its pieces, not as a plain bar. `map` is the server's `pieceMap` (up to
// 100 slices, each byte the share of its pieces verified, base64); each slice
// is the fill colour mixed into the track by that share, so a stream that has
// its start and its end, a torrent stuck on a few pieces, or a season pack
// with one episode done reads at a glance. One CSS gradient: no canvas,
// crisp at any width.

type Download = Schemas['Download']
export type StripTone = 'down' | 'up' | 'idle' | 'fault'

function decode(map: string): number[] {
  try {
    return Array.from(atob(map), (c) => c.charCodeAt(0))
  } catch {
    return []
  }
}

function gradient(slices: number[]): string {
  const n = slices.length
  const stops = slices.map((v, i) => {
    const colour = `color-mix(in oklch, var(--strip-fill) ${Math.round((v / 255) * 100)}%, var(--strip-track))`
    return `${colour} ${((i / n) * 100).toFixed(2)}% ${(((i + 1) / n) * 100).toFixed(2)}%`
  })
  return `linear-gradient(to right, ${stops.join(', ')})`
}

/** The strip's colour for a download's state: down while it downloads, up once it seeds or is done. */
export function toneOf(d: Pick<Download, 'state'>): StripTone {
  if (d.state === 'error') return 'fault'
  if (d.state === 'seeding' || d.state === 'completed') return 'up'
  if (d.state === 'paused' || d.state === 'queued') return 'idle'
  return 'down'
}

export function SwarmStrip({
  map,
  progress,
  tone = 'down',
  className,
  label,
  marks,
}: {
  map: string | null | undefined
  /** 0–1, drawn as one run when the pieces aren't known; null = nothing known yet */
  progress: number | null
  tone?: StripTone
  className?: string
  label?: string
  /** what players read now (0–1 of the torrent): drawn in gold over the strip */
  marks?: { from: number; to: number }[]
}) {
  const background = useMemo(() => {
    if (map) {
      const slices = decode(map)
      if (slices.length) return gradient(slices)
    }
    // nothing known: waiting stripes while it runs, an empty track while it's stopped
    if (progress === null) return tone === 'idle' ? 'none' : undefined
    const pct = (progress * 100).toFixed(2)
    return `linear-gradient(to right, var(--strip-fill) ${pct}%, var(--strip-track) ${pct}%)`
  }, [map, progress, tone])
  return (
    <div
      role="img"
      aria-label={label ?? (progress === null ? 'Waiting for the torrent’s metadata' : `${Math.floor(progress * 100)} % done`)}
      data-tone={tone}
      data-waiting={background === undefined ? '' : undefined}
      className={cn('strip relative h-1.5 w-full overflow-hidden rounded-[2px] bg-(--strip-track)', className)}
      style={background && background !== 'none' ? { backgroundImage: background } : undefined}
    >
      {marks?.map((m, i) => (
        <span
          key={i}
          className="absolute inset-y-0 min-w-0.5 bg-primary"
          style={{ left: `${m.from * 100}%`, width: `${Math.max(0, m.to - m.from) * 100}%` }}
        />
      ))}
    </div>
  )
}
