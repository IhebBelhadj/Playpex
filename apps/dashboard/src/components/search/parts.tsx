import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { ChevronDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { api, errorMessage, unwrap } from '@/lib/api'
import { useDirectActions } from '@/lib/direct'
import { usePlayer } from '@/lib/player'
import type { Release, SourceState, StreamItem } from '@/lib/search'
import { cn } from '@/lib/utils'

// What Search's groups share: the filters (torrents and streams alike: names
// that hold every word, quality, size; torrents also episodes, season, plays
// as is), the seed bars, the sources' summary, the actions.

export type Quality = '2160p' | '1080p' | '720p' | 'SD' | 'unknown'
type SizeBand = 's' | 'm' | 'l' | 'xl'
type Shape = 'episode' | 'pack'

export type Filters = {
  loose: boolean
  quality: Quality | null
  size: SizeBand | null
  plays: boolean
  shape: Shape | null
  season: number | null
}

export const NO_FILTERS: Filters = { loose: false, quality: null, size: null, plays: false, shape: null, season: null }

export const QUALITIES: { id: Quality; label: string }[] = [
  { id: '2160p', label: '4K (2160p)' },
  { id: '1080p', label: '1080p' },
  { id: '720p', label: '720p' },
  { id: 'SD', label: 'SD' },
  { id: 'unknown', label: 'Not stated' },
]

const GB = 1024 ** 3
export const SIZES: { id: SizeBand; label: string; test: (n: number) => boolean }[] = [
  { id: 's', label: 'Under 1 GB', test: (n) => n < GB },
  { id: 'm', label: '1 to 4 GB', test: (n) => n >= GB && n < 4 * GB },
  { id: 'l', label: '4 to 15 GB', test: (n) => n >= 4 * GB && n < 15 * GB },
  { id: 'xl', label: 'Over 15 GB', test: (n) => n >= 15 * GB },
]

/** A torrent or a stream, as the facets read it */
export type Offer = Release | StreamItem

export const qualityOf = (t: Offer): Quality => (t.quality === '480p' ? 'SD' : ((t.quality as Quality | null) ?? 'unknown'))
/** Plays in Playpex TV as it is: video Chromium decodes, audio it doesn't have to convert */
export const playsAsIs = (t: Offer) => ('playable' in t ? !!t.playable : !/hevc|x265|h265/i.test(t.codec ?? '')) && t.audio !== 'unsupported'

// every facet but one: a facet's counts are what choosing it would leave
export function keep(t: Offer, f: Filters, except?: keyof Filters) {
  if (except !== 'loose' && !f.loose && t.matches === false) return false
  if (except !== 'quality' && f.quality && qualityOf(t) !== f.quality) return false
  if (except !== 'size' && f.size && !(t.size && SIZES.find((s) => s.id === f.size)!.test(t.size))) return false
  if (except !== 'plays' && f.plays && !playsAsIs(t)) return false
  const pack = 'pack' in t ? !!t.pack : false
  if (except !== 'shape' && f.shape && (f.shape === 'pack' ? !pack : pack || t.episode == null)) return false
  if (except !== 'season' && f.season !== null && t.season !== f.season) return false
  return true
}

const ANY = 'any'

/** One row of small selects above a list of torrents or streams; each option counts what choosing it would leave */
export function FilterBar({ all, filters, set, torrents, shows }: { all: Offer[]; filters: Filters; set: (p: Partial<Filters>) => void; torrents: boolean; shows: boolean }) {
  const count = (except: keyof Filters, test: (t: Offer) => boolean) => all.filter((t) => keep(t, filters, except) && test(t)).length
  const seasons = [...new Set(all.map((t) => t.season).filter((s): s is number => s != null))].sort((a, b) => a - b)
  const qualities = QUALITIES.map((x) => ({ ...x, n: count('quality', (t) => qualityOf(t) === x.id) })).filter((x) => x.n || filters.quality === x.id)
  return (
    <div role="group" aria-label="Filters" className="flex flex-wrap items-center gap-2">
      <Pick label="Quality" value={filters.quality ?? ANY} onChange={(v) => set({ quality: v === ANY ? null : (v as Quality) })} options={[{ id: ANY, label: 'Any quality' }, ...qualities.map((x) => ({ id: x.id, label: x.label, n: x.n }))]} />
      <Pick
        label="Size"
        value={filters.size ?? ANY}
        onChange={(v) => set({ size: v === ANY ? null : (v as SizeBand) })}
        options={[{ id: ANY, label: 'Any size' }, ...SIZES.map((x) => ({ id: x.id, label: x.label, n: count('size', (t) => !!t.size && x.test(t.size)) }))]}
      />
      {torrents && shows && (
        <Pick
          label="Episodes"
          value={filters.shape ?? ANY}
          onChange={(v) => set({ shape: v === ANY ? null : (v as Shape) })}
          options={[
            { id: ANY, label: 'Episodes and packs' },
            { id: 'episode', label: 'Single episodes', n: count('shape', (t) => !('pack' in t && t.pack) && t.episode != null) },
            { id: 'pack', label: 'Season packs', n: count('shape', (t) => 'pack' in t && !!t.pack) },
          ]}
        />
      )}
      {shows && seasons.length > 1 && (
        <Pick
          label="Season"
          value={filters.season === null ? ANY : String(filters.season)}
          onChange={(v) => set({ season: v === ANY ? null : Number(v) })}
          options={[{ id: ANY, label: 'Every season' }, ...seasons.map((x) => ({ id: String(x), label: x === 0 ? 'Specials' : `Season ${x}`, n: count('season', (t) => t.season === x) }))]}
        />
      )}
      {torrents && (
        <button
          type="button"
          aria-pressed={filters.plays}
          onClick={() => set({ plays: !filters.plays })}
          className={cn(
            'h-8 rounded-full px-3.5 text-sm transition-colors',
            filters.plays ? 'bg-gold text-gold-foreground' : 'border border-input text-muted-foreground hover:text-foreground',
          )}
        >
          Plays on the TV as is
        </button>
      )}
    </div>
  )
}

function Pick({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { id: string; label: string; n?: number }[] }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" aria-label={label} className={cn(value !== ANY && 'border-gold text-foreground')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            {o.label}
            {o.n !== undefined && <span className="ml-auto pl-3 text-xs text-muted-foreground tabular-nums">{o.n}</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Seeds as signal bars, one per order of magnitude (1, 10, 100, 1000+): a swarm's strength at a glance */
export function Seeds({ seeds }: { seeds: number }) {
  const lit = seeds >= 1000 ? 4 : seeds >= 100 ? 3 : seeds >= 10 ? 2 : seeds >= 1 ? 1 : 0
  return (
    <span className="inline-flex items-center justify-end gap-2" title={`${seeds} ${seeds === 1 ? 'seed' : 'seeds'}`}>
      <span className={cn(seeds === 0 && 'text-muted-foreground')}>{seeds}</span>
      <span aria-hidden className="flex h-3 items-end gap-[2px]">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={cn('w-[3px] rounded-[1px]', i < lit ? 'bg-up' : 'bg-muted-foreground/25')} style={{ height: `${(i + 1) * 25}%` }} />
        ))}
      </span>
    </span>
  )
}

/** How the search went, in one sentence; the sources themselves (and switches to leave one out) in a popover */
export function SourcesSummary({ states, fixed, off, onToggle }: { states: SourceState[]; fixed: SourceState[]; off: string[]; onToggle: (id: string) => void }) {
  const all = [...fixed, ...states]
  const asking = all.filter((s) => s.state === 'searching').length
  const failed = all.filter((s) => s.state === 'failed').length
  const found = all.filter((s) => s.state === 'done' && (s.count > 0 || s.loose > 0)).length
  const left = states.filter((s) => off.includes(s.source.id)).length
  const sentence = asking
    ? `Asking ${all.length} sources, ${all.length - asking} answered so far.`
    : `${all.length} sources answered, ${found} found something.`
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
      {asking > 0 && <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-down" />}
      <span aria-live="polite">
        {sentence}
        {failed > 0 && <span className="text-destructive"> {failed} failed.</span>}
        {left > 0 && ` ${left} left out.`}
      </span>
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="inline-flex items-center gap-0.5 text-foreground underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground">
            Sources <ChevronDown className="size-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-2">
          <ul className="max-h-80 overflow-x-hidden overflow-y-auto">
            {all.map((s) => {
              const optional = !fixed.includes(s)
              const hidden = off.includes(s.source.id)
              return (
                <li key={s.source.group + s.source.id} className="flex items-center gap-3 rounded-xl px-2 py-2">
                  <SourceDot state={s.state} found={s.count > 0} />
                  <span className="min-w-0 flex-1">
                    <span className={cn('block truncate text-sm', hidden && 'text-muted-foreground')}>{s.source.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      <SourceCount state={s} />
                    </span>
                  </span>
                  {optional && <Switch size="sm" checked={!hidden} onCheckedChange={() => onToggle(s.source.id)} aria-label={`Use ${s.source.name}`} />}
                </li>
              )
            })}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  )
}

export function SourceDot({ state, found }: { state: SourceState['state']; found: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'size-1.5 rounded-full',
        state === 'searching' && 'animate-pulse bg-down',
        state === 'done' && (found ? 'bg-up' : 'bg-muted-foreground/50'),
        state === 'failed' && 'bg-destructive',
        state === 'idle' && 'bg-muted-foreground/40',
      )}
    />
  )
}

function SourceCount({ state: s }: { state: SourceState }) {
  if (s.state === 'idle') return <>waiting for a search</>
  if (s.state === 'searching') return <>searching…</>
  if (s.state === 'failed') return <span className="text-destructive">{errorMessage(s.error)}</span>
  if (!s.count && !s.loose) return <>nothing found</>
  return (
    <>
      {s.count} found{s.loose > 0 && `, ${s.loose} near ${s.loose === 1 ? 'match' : 'matches'}`}
    </>
  )
}

/** A torrent's provider is the plugin's id, a source's id `plugin:<id>` */
export function sameSource(provider: string, sourceId: string) {
  return sourceId === provider || sourceId === `plugin:${provider}`
}

/** What Search does with what it found: play a ref, download it, start a torrent */
export function useSearchActions() {
  const player = usePlayer()
  const direct = useDirectActions()
  const client = useQueryClient()
  const startTorrent = useMutation({
    mutationFn: (v: { magnet: string; name: string }) => unwrap(api.POST('/downloads', { body: { link: v.magnet } })),
    onSuccess: (d, v) => {
      toast.success(`Added ${d.name ?? v.name}`, { description: d.state === 'queued' ? `Queued #${d.queuePosition ?? 1}: it starts when a slot is free.` : undefined })
      client.invalidateQueries({ queryKey: ['downloads'] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return {
    play: (ref: string, title: string, detail?: string) => player.play({ ref, title, detail }),
    download: (ref: string, name?: string) => direct.add.mutate({ ref, name }),
    downloading: direct.add.isPending,
    startTorrent: (magnet: string, name: string) => startTorrent.mutate({ magnet, name }),
    copy: (text: string, what: string) =>
      navigator.clipboard.writeText(text).then(
        () => toast.success(`${what} copied`),
        () => toast.error(`Could not copy the ${what.toLowerCase()}`),
      ),
  }
}

/** A group's heading in the overview: its name, how many, a way to see them all */
export function SectionHead({ title, count, onAll, children }: { title: string; count?: number; onAll?: () => void; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      {count !== undefined && <span className="text-sm text-muted-foreground tabular-nums">{count}</span>}
      {children}
      {onAll && (
        <button type="button" onClick={onAll} className="ml-auto text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          See all {count}
        </button>
      )}
    </div>
  )
}
