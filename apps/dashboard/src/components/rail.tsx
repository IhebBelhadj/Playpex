import { useEffect, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

// A page's filter rail (Downloads, Find torrents): groups of items with a
// count, the chosen one on a grey step with its count in gold (no edge); phones get a select or a sheet instead.
// Rails show from RAIL_WIDTH: under it the app's sidebar leaves too little room
// beside one.
export const RAIL_WIDTH = 1024

export function useIsDesktop(minWidth = 768) {
  const query = `(min-width: ${minWidth}px)`
  const [desktop, setDesktop] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const m = window.matchMedia(query)
    const change = () => setDesktop(m.matches)
    m.addEventListener('change', change)
    return () => m.removeEventListener('change', change)
  }, [query])
  return desktop
}

export function RailGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      {title && <p className="px-3 pb-1.5 text-xs text-muted-foreground/80">{title}</p>}
      {children}
    </div>
  )
}

export function RailItem({ label, count, active, tone, onClick }: { label: string; count: number; active: boolean; tone?: 'fault'; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex h-[34px] items-center gap-2 rounded-full px-3 text-left text-sm transition-colors hover:text-foreground',
        active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground',
        tone === 'fault' && 'text-destructive',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className={cn('text-xs tabular-nums', active ? 'text-gold' : count === 0 && 'opacity-50')}>{count}</span>
    </button>
  )
}
