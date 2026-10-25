import { useEffect, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

// A page's filter rail (Downloads, Find torrents): groups of items with a
// count, the chosen one marked in gold; phones get a select or a sheet instead.

export function useIsDesktop() {
  const query = '(min-width: 768px)'
  const [desktop, setDesktop] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const m = window.matchMedia(query)
    const change = () => setDesktop(m.matches)
    m.addEventListener('change', change)
    return () => m.removeEventListener('change', change)
  }, [])
  return desktop
}

export function RailGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      {title && <p className="px-2.5 pb-1 text-xs font-medium text-muted-foreground">{title}</p>}
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
        'flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted',
        active ? 'bg-muted font-medium text-foreground shadow-[inset_2px_0_0_var(--primary)]' : 'text-muted-foreground',
        tone === 'fault' && 'text-destructive',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className={cn('text-xs tabular-nums', count === 0 && 'opacity-50')}>{count}</span>
    </button>
  )
}
