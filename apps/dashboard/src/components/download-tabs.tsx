import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, HelpCircle, Plus, Radio, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Loading, QueryError, Spinner } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ApiError, api, errorMessage, unwrap, type Schemas } from '@/lib/api'
import { RUNNING, useDownloadActions, useEngineCaps, type Download } from '@/lib/downloads'
import { ago, bytes, speed } from '@/lib/format'
import { cn } from '@/lib/utils'

// The detail pane's swarm tabs (docs/dashboard-plan.md §4.3, step 4): Peers,
// Trackers, Pieces, Speed. Each polls its route every 2 s while it is shown;
// what the running engine can't tell is said once, with its name (decision D).

const POLL = 2000

function useEngineName() {
  const overview = useQuery({ queryKey: ['overview'], queryFn: () => unwrap(api.GET('/admin/overview')), staleTime: 5000 })
  return overview.data?.downloads.engine ?? 'running'
}

function NotReported({ what }: { what: string }) {
  const engine = useEngineName()
  return (
    <p className="p-4 text-sm text-muted-foreground">
      The {engine} engine doesn't report {what}. Settings › Downloads lists the engines that do.
    </p>
  )
}

function Stopped({ children }: { children: ReactNode }) {
  return <p className="p-4 text-sm text-muted-foreground">{children}</p>
}

function failure(error: unknown, what: string) {
  if (error instanceof ApiError && error.code === 'NOT_SUPPORTED') return <NotReported what={what} />
  return (
    <div className="p-4">
      <QueryError error={error} title={`Could not load ${what}`} />
    </div>
  )
}

const percent = (v: number | null) => (v === null ? '—' : `${Math.floor(v * 1000) / 10} %`)

// ── Peers ────────────────────────────────────────────────────────────────────

const FLAGS: [string, string][] = [
  ['D', 'Downloading from it'],
  ['d', 'We want its pieces, it chokes us'],
  ['U', 'Uploading to it'],
  ['u', 'It wants our pieces, we choke it'],
  ['I', 'It connected to us'],
  ['X', 'Found by peer exchange'],
  ['H', 'Found on the DHT'],
  ['P', 'µTP'],
]

export function PeersTab({ d }: { d: Download }) {
  const peers = useQuery({
    queryKey: ['download-peers', d.infoHash],
    queryFn: () => unwrap(api.GET('/downloads/{infoHash}/peers', { params: { path: { infoHash: d.infoHash } } })),
    refetchInterval: POLL,
    retry: false,
  })
  if (peers.isPending) return <PaneLoading />
  if (peers.error) return failure(peers.error, 'its peers')
  const { running, peers: list, availability } = peers.data
  if (!running) return <Stopped>Not running: no peers are connected. Start it to see its swarm.</Stopped>
  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center gap-4 border-b bg-card px-3 py-1.5 text-xs text-muted-foreground tabular-nums">
        <span>
          {list.length} {list.length === 1 ? 'peer' : 'peers'} connected
        </span>
        {availability !== null && <span title="Distributed copies among the connected peers">Availability {availability.toFixed(2)}</span>}
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" className="ml-auto inline-flex items-center gap-1 hover:text-foreground">
              <HelpCircle className="size-3.5" /> What the flags mean
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72">
            <dl className="grid grid-cols-[1.5rem_1fr] gap-x-2 gap-y-1 text-sm">
              {FLAGS.map(([f, text]) => (
                <div key={f} className="contents">
                  <dt className="font-mono font-medium">{f}</dt>
                  <dd className="text-muted-foreground">{text}</dd>
                </div>
              ))}
            </dl>
          </PopoverContent>
        </Popover>
      </div>
      {list.length === 0 ? (
        <Stopped>No peer is connected right now. Peers come and go: the swarm may be small, or still being found.</Stopped>
      ) : (
        <table className="w-full border-separate border-spacing-0 text-[13px]">
          <thead className="text-xs text-muted-foreground">
            <tr className="[&>th]:border-b [&>th]:px-2 [&>th]:py-1.5 [&>th]:font-medium [&>th]:whitespace-nowrap">
              <th className="pl-3 text-left">Address</th>
              <th className="text-left">Client</th>
              <th className="text-left">Flags</th>
              <th className="text-right">Has</th>
              <th className="text-right">Down</th>
              <th className="text-right">Up</th>
              <th className="hidden text-right lg:table-cell">Received</th>
              <th className="hidden pr-3 text-right lg:table-cell">Sent</th>
            </tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.address} className="hover:bg-muted/50 [&>td]:border-b [&>td]:px-2 [&>td]:py-1.5">
                <td className="pl-3 font-mono text-xs">{p.address}</td>
                <td className="max-w-48 truncate">{p.client ?? <span className="text-muted-foreground">Unknown</span>}</td>
                <td className="font-mono text-xs tracking-wider">{p.flags || '—'}</td>
                <td className="text-right">{percent(p.progress)}</td>
                <td className="text-right">{p.downloadSpeed ? <span className="text-down">{speed(p.downloadSpeed)}</span> : '—'}</td>
                <td className="text-right">{p.uploadSpeed ? <span className="text-up">{speed(p.uploadSpeed)}</span> : '—'}</td>
                <td className="hidden text-right lg:table-cell">{bytes(p.downloaded)}</td>
                <td className="hidden pr-3 text-right lg:table-cell">{bytes(p.uploaded)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function PaneLoading() {
  return (
    <div className="p-4">
      <Loading rows={2} />
    </div>
  )
}

// ── Trackers ────────────────────────────────────────────────────────────────

const STATUS: Record<string, string> = {
  working: 'Working',
  updating: 'Updating…',
  error: 'Error',
  'not-contacted': 'Not contacted yet',
  unknown: '',
  stopped: 'Not running',
}

export function TrackersTab({ d }: { d: Download }) {
  const client = useQueryClient()
  const engine = useEngineName()
  const caps = useEngineCaps()
  const actions = useDownloadActions()
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')
  const key = ['download-trackers', d.infoHash]
  const trackers = useQuery({
    queryKey: key,
    queryFn: () => unwrap(api.GET('/downloads/{infoHash}/trackers', { params: { path: { infoHash: d.infoHash } } })),
    // faster while a scrape's answers come in
    refetchInterval: (q) => (q.state.data?.scraping ? POLL : POLL * 5),
    retry: false,
  })
  const add = useMutation({
    mutationFn: (urls: string[]) =>
      unwrap(api.POST('/downloads/{infoHash}/trackers', { params: { path: { infoHash: d.infoHash } }, body: { add: urls } })),
    onSuccess: (answer, urls) => {
      client.setQueryData(key, answer)
      toast.success(urls.length === 1 ? 'Tracker added' : `${urls.length} trackers added`)
      setText('')
      setAdding(false)
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const remove = useMutation({
    mutationFn: (url: string) =>
      unwrap(api.POST('/downloads/{infoHash}/trackers', { params: { path: { infoHash: d.infoHash } }, body: { remove: [url] } })),
    onSuccess: (answer) => {
      client.setQueryData(key, answer)
      toast.success('Tracker removed', { description: 'Left out from its next start: the engine may still announce to it until then.' })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  if (trackers.isPending) return <PaneLoading />
  if (trackers.error) return failure(trackers.error, 'its trackers')
  const list = trackers.data.trackers
  const unknown = list.some((t) => t.status === 'unknown')
  const urls = text
    .split(/\s+/)
    .map((u) => u.trim())
    .filter(Boolean)
  return (
    <div>
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b bg-card px-3 py-1.5 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {list.length} {list.length === 1 ? 'tracker' : 'trackers'}
        </span>
        {unknown && <span>The {engine} engine doesn't report how each tracker answers.</span>}
        {trackers.data.scraping && (
          <span className="flex items-center gap-1.5">
            <Spinner className="size-3" /> Asking them…
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {caps.can('reannounce') && (
            <Button
              variant="ghost"
              size="xs"
              disabled={!RUNNING.includes(d.state) || actions.reannounce.isPending}
              title={RUNNING.includes(d.state) ? 'Ask its trackers for peers now' : 'Start it first: only a running torrent announces'}
              onClick={() => actions.reannounce.mutate([d.infoHash])}
            >
              <Radio /> Announce again
            </Button>
          )}
          {caps.can('trackerEdit') && (
            <Button variant="ghost" size="xs" onClick={() => setAdding((a) => !a)}>
              <Plus /> Add trackers
            </Button>
          )}
        </span>
      </div>
      {adding && (
        <form
          className="space-y-2 border-b bg-muted/30 p-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (urls.length) add.mutate(urls)
          }}
        >
          <label htmlFor="add-trackers" className="text-sm font-medium">
            Announce URLs, one per line
          </label>
          <textarea
            id="add-trackers"
            autoFocus
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="udp://tracker.example.org:1337/announce"
            className="w-full rounded-2xl border border-input bg-transparent px-3.5 py-2.5 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!urls.length || add.isPending}>
              {add.isPending && <Spinner />} Add {urls.length > 1 ? `${urls.length} trackers` : 'tracker'}
            </Button>
          </div>
        </form>
      )}
      <ul className="divide-y">
        {list.map((t) => (
          <li key={t.url} className="group flex items-center gap-2 px-3 py-2 hover:bg-muted/50">
            {/* two lines: the address, then what is known about it (wraps on a phone, never widens the pane) */}
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-xs" title={t.url}>
                {t.url}
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                {t.ours && <span>Added by Playpex</span>}
                {t.added && <span>Added by you</span>}
                {t.seeds !== null && <span className="text-foreground tabular-nums">{t.seeds} seeds</span>}
                {t.peers !== null && <span className="text-foreground tabular-nums">{t.peers} peers</span>}
                {t.seeds === null && t.swarm && (
                  <span
                    className={cn('tabular-nums', !t.swarm.error && 'text-foreground')}
                    title={t.swarm.error ? `${t.swarm.error} (${ago(t.swarm.at)})` : `Its scrape, ${ago(t.swarm.at)}${t.swarm.downloaded !== null ? `: ${t.swarm.downloaded} downloads done` : ''}`}
                  >
                    {t.swarm.error ? 'No answer' : `${t.swarm.seeds ?? '?'} seeds, ${t.swarm.peers ?? '?'} leechers`}
                  </span>
                )}
                {STATUS[t.status] && (
                  <span className={cn(t.status === 'error' && 'text-destructive')} title={t.message ?? undefined}>
                    {STATUS[t.status]}
                  </span>
                )}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Copy the URL"
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
              onClick={() => navigator.clipboard.writeText(t.url).then(() => toast.success('URL copied'))}
            >
              <Copy />
            </Button>
            {caps.can('trackerRemove') && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${t.url}`}
                title="Remove it from this torrent"
                disabled={remove.isPending}
                className="opacity-0 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                onClick={() => remove.mutate(t.url)}
              >
                <X />
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Pieces ──────────────────────────────────────────────────────────────────

type Pieces = Schemas['DownloadPieces']

function decodeBits(b64: string | null, count: number): Uint8Array {
  const out = new Uint8Array(count)
  if (!b64) return out
  const raw = atob(b64)
  for (let i = 0; i < count; i++) out[i] = raw.charCodeAt(i >> 3) & (0x80 >> (i & 7)) ? 1 : 0
  return out
}

function cssVar(el: Element, name: string) {
  return getComputedStyle(el).getPropertyValue(name).trim()
}

export function PiecesTab({ d }: { d: Download }) {
  const pieces = useQuery({
    queryKey: ['download-pieces', d.infoHash],
    queryFn: () => unwrap(api.GET('/downloads/{infoHash}/pieces', { params: { path: { infoHash: d.infoHash } } })),
    refetchInterval: POLL,
  })
  if (pieces.isPending) return <PaneLoading />
  if (pieces.error) return failure(pieces.error, 'its pieces')
  if (!pieces.data.count) return <Stopped>Its pieces are known once the torrent's metadata arrives.</Stopped>
  return <PieceMap p={pieces.data} done={d.state === 'seeding' || d.state === 'completed'} />
}

function PieceMap({ p, done }: { p: Pieces; done: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const have = useMemo(() => decodeBits(p.have, p.count), [p.have, p.count])
  const wanted = useMemo(() => {
    const w = new Uint8Array(p.count)
    for (const f of p.files) for (let i = f.first; i <= f.last; i++) w[i] = 1
    return w
  }, [p.files, p.count])
  // 1: in a player's read-ahead, 2: the piece it reads now
  const streamed = useMemo(() => {
    const s = new Uint8Array(p.count)
    for (const r of p.reads) {
      for (let i = r.position; i <= Math.min(r.ahead, p.count - 1); i++) s[i] = Math.max(s[i], 1)
      if (r.position < p.count) s[r.position] = 2
    }
    return s
  }, [p.reads, p.count])

  // cells shrink with the count, so a big torrent still fits a few lines
  const cell = p.count <= 600 ? 10 : p.count <= 3000 ? 6 : p.count <= 12000 ? 4 : 3
  const gap = cell >= 6 ? 2 : 1
  const perLine = Math.max(1, Math.floor((width + gap) / (cell + gap)))
  const lines = Math.ceil(p.count / perLine)

  useEffect(() => {
    if (!box.current) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)))
    observer.observe(box.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const c = canvas.current
    if (!c || !width) return
    const ratio = window.devicePixelRatio || 1
    const height = lines * (cell + gap)
    c.width = width * ratio
    c.height = height * ratio
    c.style.height = `${height}px`
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.scale(ratio, ratio)
    const fill = cssVar(c, done ? '--up' : '--down')
    const track = cssVar(c, '--strip-track')
    const skipped = cssVar(c, '--border')
    const gold = cssVar(c, '--primary')
    const ink = cssVar(c, '--foreground')
    for (let i = 0; i < p.count; i++) {
      const x = (i % perLine) * (cell + gap)
      const y = Math.floor(i / perLine) * (cell + gap)
      // a player's read-ahead in gold: filled once verified, outlined while missing; its position in ink
      ctx.fillStyle = streamed[i] === 2 ? ink : streamed[i] && have[i] ? gold : have[i] ? fill : wanted[i] ? track : skipped
      ctx.globalAlpha = !have[i] && !wanted[i] && !streamed[i] ? 0.5 : 1
      ctx.fillRect(x, y, cell, cell)
      if (streamed[i] === 1 && !have[i]) {
        ctx.strokeStyle = gold
        ctx.lineWidth = cell >= 6 ? 1.5 : 1
        ctx.strokeRect(x + 0.75, y + 0.75, cell - 1.5, cell - 1.5)
      }
    }
    ctx.globalAlpha = 1
  }, [width, lines, cell, gap, perLine, have, wanted, streamed, p.count, done])

  const pick = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const col = Math.floor((e.clientX - rect.left) / (cell + gap))
    const row = Math.floor((e.clientY - rect.top) / (cell + gap))
    const i = row * perLine + col
    setHover(col < perLine && i >= 0 && i < p.count ? i : null)
  }

  const count = have.reduce((n, v) => n + v, 0)
  const fileOf = (i: number) => p.files.find((f) => i >= f.first && i <= f.last)?.path ?? null
  const name = (path: string) => path.split('/').pop() ?? path

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs text-muted-foreground tabular-nums">
        <span>
          <span className="text-foreground">{count.toLocaleString()}</span> of {p.count.toLocaleString()} pieces
          {p.pieceLength ? ` · ${bytes(p.pieceLength)} each` : ''}
        </span>
        <Legend swatch={done ? 'bg-up' : 'bg-down'}>Have</Legend>
        <Legend swatch="bg-(--strip-track)">Missing</Legend>
        <Legend swatch="bg-border opacity-50">Not downloaded (files left out)</Legend>
        <Legend swatch="bg-gold">Being streamed</Legend>
        <Legend swatch="bg-foreground">Read now</Legend>
      </div>
      <div ref={box} className="w-full">
        <canvas
          ref={canvas}
          className="block w-full"
          role="img"
          aria-label={`Piece map: ${count} of ${p.count} pieces verified`}
          onPointerMove={pick}
          onPointerLeave={() => setHover(null)}
        />
      </div>
      <p className="min-h-5 text-xs text-muted-foreground tabular-nums">
        {hover !== null ? (
          <>
            Piece {hover.toLocaleString()}
            {fileOf(hover) && ` · ${name(fileOf(hover)!)}`} · {have[hover] ? 'verified' : wanted[hover] ? 'missing' : 'not downloaded'}
            {streamed[hover] === 2 ? ' · a player reads it now' : streamed[hover] ? ' · being streamed' : ''}
          </>
        ) : p.reads.length ? null : (
          'No player is reading it now.'
        )}
      </p>
      {p.reads.length > 0 && (
        <ul className="space-y-1 text-sm">
          {p.reads.map((r, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-x-2">
              <span className="inline-block size-2 rounded-[2px] bg-gold" aria-hidden />
              <span className="font-medium">{name(r.path)}</span>
              {r.devices.length > 0 && <span className="text-muted-foreground">on {r.devices.join(', ')}</span>}
              <span className="text-xs text-muted-foreground tabular-nums">
                reading piece {r.position.toLocaleString()}, ahead to {Math.min(r.ahead, p.count - 1).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Legend({ swatch, children }: { swatch: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('inline-block size-2.5 rounded-[2px]', swatch)} aria-hidden />
      {children}
    </span>
  )
}

// ── Speed ───────────────────────────────────────────────────────────────────

type Sample = Schemas['DownloadSpeed']['samples'][number]

// 1, 2, 2.5, 5 × 10^n of the unit the peak reads in (KB/s, MB/s: 1024-based
// like bytes()), so the ticks are round numbers: a scale's top a little over the peak
function niceMax(v: number) {
  if (v <= 0) return 1024
  let unit = 1
  while (v >= unit * 1024 && unit < 1024 ** 3) unit *= 1024
  const x = v / unit
  const p = Math.pow(10, Math.floor(Math.log10(x)))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= x) return m * p * unit
  return 10 * p * unit
}

export function SpeedTab({ d }: { d: Download }) {
  const history = useQuery({
    queryKey: ['download-speed', d.infoHash],
    queryFn: () => unwrap(api.GET('/downloads/{infoHash}/speed', { params: { path: { infoHash: d.infoHash } } })),
    refetchInterval: POLL,
  })
  if (history.isPending) return <PaneLoading />
  if (history.error) return failure(history.error, 'its speed')
  const samples = history.data.samples
  if (samples.length < 2) {
    return <Stopped>No speeds yet: the server keeps the last 10 minutes of a torrent while it runs.</Stopped>
  }
  return <SpeedChart samples={samples} />
}

function SpeedChart({ samples }: { samples: Sample[] }) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  const [at, setAt] = useState<number | null>(null)
  useEffect(() => {
    if (!box.current) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.floor(entry.contentRect.width))))
    observer.observe(box.current)
    return () => observer.disconnect()
  }, [])

  const H = 150
  const left = 64
  const right = 12
  const top = 8
  const bottom = 22
  const t0 = Date.parse(samples[0].at)
  const t1 = Date.parse(samples[samples.length - 1].at)
  const span = Math.max(1, t1 - t0)
  const max = niceMax(Math.max(...samples.map((s) => Math.max(s.down, s.up))))
  const x = (s: Sample) => left + ((Date.parse(s.at) - t0) / span) * (width - left - right)
  const y = (v: number) => top + (1 - v / max) * (H - top - bottom)
  const path = (key: 'down' | 'up') => samples.map((s, i) => `${i ? 'L' : 'M'}${x(s).toFixed(1)},${y(s[key]).toFixed(1)}`).join('')
  const ticks = [0, max / 2, max]
  const last = samples[samples.length - 1]
  const peak = Math.max(...samples.map((s) => s.down))
  const avg = samples.reduce((n, s) => n + s.down, 0) / samples.length
  const minutes = Math.round(span / 60000)

  const move = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    let best = 0
    for (let i = 1; i < samples.length; i++) if (Math.abs(x(samples[i]) - px) < Math.abs(x(samples[best]) - px)) best = i
    setAt(best)
  }
  const hovered = at !== null ? samples[at] : null

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs text-muted-foreground tabular-nums">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 rounded-full bg-(--chart-down)" aria-hidden />
          Download <span className="text-foreground">{speed(last.down)}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 rounded-full bg-(--chart-up)" aria-hidden />
          Upload <span className="text-foreground">{speed(last.up)}</span>
        </span>
        <span>
          Average down {speed(avg)} · peak {speed(peak)}
        </span>
        <span className="ml-auto">
          {last.peers} {last.peers === 1 ? 'peer' : 'peers'} now
        </span>
      </div>
      <div ref={box} className="relative">
        <svg
          width={width}
          height={H}
          className="block touch-none"
          role="img"
          aria-label={`Speed over the last ${minutes || 1} minutes: download now ${speed(last.down)}, upload ${speed(last.up)}`}
          onPointerMove={move}
          onPointerLeave={() => setAt(null)}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line x1={left} x2={width - right} y1={y(v)} y2={y(v)} className="stroke-border" strokeWidth={1} />
              <text x={left - 8} y={y(v)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">
                {speed(v)}
              </text>
            </g>
          ))}
          <text x={left} y={H - 6} className="fill-muted-foreground text-[11px]">
            {minutes ? `${minutes} min ago` : 'just now'}
          </text>
          <text x={width - right} y={H - 6} textAnchor="end" className="fill-muted-foreground text-[11px]">
            now
          </text>
          <path d={path('up')} fill="none" stroke="var(--chart-up)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <path d={path('down')} fill="none" stroke="var(--chart-down)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {hovered && (
            <g>
              <line x1={x(hovered)} x2={x(hovered)} y1={top} y2={H - bottom} className="stroke-muted-foreground" strokeWidth={1} />
              <circle cx={x(hovered)} cy={y(hovered.down)} r={4} fill="var(--chart-down)" className="stroke-card" strokeWidth={2} />
              <circle cx={x(hovered)} cy={y(hovered.up)} r={4} fill="var(--chart-up)" className="stroke-card" strokeWidth={2} />
            </g>
          )}
        </svg>
        {hovered && (
          <div
            className="pointer-events-none absolute top-1 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md tabular-nums"
            style={x(hovered) > width / 2 ? { right: width - x(hovered) + 10 } : { left: x(hovered) + 10 }}
          >
            <div className="mb-1 text-muted-foreground">{new Date(hovered.at).toLocaleTimeString()}</div>
            <div className="flex items-center gap-2">
              <span className="inline-block h-0.5 w-3 rounded-full bg-(--chart-down)" aria-hidden />
              <span className="font-medium">{speed(hovered.down)}</span>
              <span className="text-muted-foreground">down</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block h-0.5 w-3 rounded-full bg-(--chart-up)" aria-hidden />
              <span className="font-medium">{speed(hovered.up)}</span>
              <span className="text-muted-foreground">up</span>
            </div>
            <div className="mt-1 text-muted-foreground">
              {hovered.peers} {hovered.peers === 1 ? 'peer' : 'peers'}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
