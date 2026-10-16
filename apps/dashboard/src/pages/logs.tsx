import { useQuery } from '@tanstack/react-query'
import { Download, Pause, Play, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Loading, PageHeader, QueryError } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { API_PREFIX, api, unwrap, type LogEntry } from '@/lib/api'
import { useEvent } from '@/lib/events'
import { time } from '@/lib/format'
import { cn } from '@/lib/utils'

const MAX = 2000
const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 } as const
const LEVEL_STYLE: Record<string, string> = {
  debug: 'text-muted-foreground',
  info: 'text-sky-500 dark:text-sky-400',
  warn: 'text-warning',
  error: 'text-destructive',
}

function extra(entry: LogEntry) {
  const rest = Object.entries(entry).filter(([k]) => !['time', 'level', 'area', 'msg'].includes(k))
  if (!rest.length) return ''
  return rest
    .map(([k, v]) => {
      if (k === 'err' && v && typeof v === 'object') return `err=${(v as { message?: string }).message ?? ''}`
      return `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`
    })
    .join(' ')
}

export function LogsPage() {
  const [level, setLevel] = useState<keyof typeof LEVEL_ORDER>('info')
  const [area, setArea] = useState('all')
  const [search, setSearch] = useState('')
  const [paused, setPaused] = useState(false)
  const [live, setLive] = useState<LogEntry[]>([])
  const held = useRef<LogEntry[]>([])
  const [heldCount, setHeldCount] = useState(0)
  const bottom = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)

  // The buffer once (debug included, filtered here); new entries come over the events socket (info and above)
  const initial = useQuery({
    queryKey: ['logs'],
    queryFn: () => unwrap(api.GET('/admin/logs', { params: { query: { limit: MAX } } })),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })

  useEvent<LogEntry>('log', (event) => {
    if (paused) {
      held.current.push(event.data)
      setHeldCount(held.current.length)
    } else {
      setLive((list) => [...list, event.data].slice(-MAX))
    }
  })

  const resume = () => {
    setLive((list) => [...list, ...held.current].slice(-MAX))
    held.current = []
    setHeldCount(0)
    setPaused(false)
  }

  const all = useMemo(() => {
    const first = initial.data?.entries ?? []
    const last = first.length ? first[first.length - 1].time : ''
    return [...first, ...live.filter((e) => e.time > last)].slice(-MAX)
  }, [initial.data, live])

  const areas = useMemo(() => [...new Set(all.map((e) => e.area))].sort(), [all])
  const needle = search.trim().toLowerCase()
  const shown = all.filter(
    (e) =>
      LEVEL_ORDER[e.level] >= LEVEL_ORDER[level] &&
      (area === 'all' || e.area === area) &&
      (!needle || e.msg.toLowerCase().includes(needle) || extra(e).toLowerCase().includes(needle)),
  )

  useEffect(() => {
    if (follow && !paused) bottom.current?.scrollIntoView({ block: 'end' })
  }, [shown.length, follow, paused])

  return (
    <>
      <PageHeader
        title="Logs"
        description={initial.data?.file ? <span className="font-mono text-xs">{initial.data.file}</span> : 'The server’s recent log'}
        actions={
          <>
            <Button variant="outline" onClick={() => (paused ? resume() : setPaused(true))}>
              {paused ? <Play /> : <Pause />} {paused ? `Resume${heldCount ? ` (${heldCount})` : ''}` : 'Pause'}
            </Button>
            <Button variant="outline" asChild>
              <a href={`${API_PREFIX}/admin/logs/download`} download>
                <Download /> Download
              </a>
            </Button>
          </>
        }
      />
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={level} onValueChange={(v) => setLevel(v as keyof typeof LEVEL_ORDER)}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="debug">Debug</SelectItem>
            <SelectItem value="info">Info</SelectItem>
            <SelectItem value="warn">Warnings</SelectItem>
            <SelectItem value="error">Errors</SelectItem>
          </SelectContent>
        </Select>
        <Select value={area} onValueChange={setArea}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All areas</SelectItem>
            {areas.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {initial.isPending ? (
        <Loading rows={6} />
      ) : initial.error ? (
        <QueryError error={initial.error} />
      ) : (
        <Card className="py-0">
          <div
            className="h-[65svh] overflow-auto p-3 font-mono text-xs leading-relaxed"
            onScroll={(e) => {
              const el = e.currentTarget
              setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
            }}
          >
            {shown.length === 0 && <p className="text-muted-foreground">No entries match.</p>}
            {shown.map((e, i) => (
              <div key={`${e.time}-${i}`} className="flex gap-2 whitespace-pre-wrap break-all hover:bg-muted/40">
                <span className="shrink-0 text-muted-foreground tabular-nums">{time(e.time)}</span>
                <span className={cn('w-10 shrink-0 uppercase', LEVEL_STYLE[e.level])}>{e.level}</span>
                <span className="w-16 shrink-0 text-muted-foreground">{e.area}</span>
                <span className="min-w-0">
                  {e.msg}
                  {extra(e) && <span className="text-muted-foreground"> {extra(e)}</span>}
                </span>
              </div>
            ))}
            <div ref={bottom} />
          </div>
        </Card>
      )}
      <p className="text-xs text-muted-foreground">
        Live entries are info and above; debug entries need the log level set to debug in Settings › General.
      </p>
    </>
  )
}
