import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { RailGroup, RailItem } from '@/components/rail'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, errorMessage, unwrap } from '@/lib/api'
import { useDirectActions } from '@/lib/direct'
import { usePlayer } from '@/lib/player'
import type { Release, SourceState, StreamItem } from '@/lib/search'
import { cn } from '@/lib/utils'

// What Search's groups share: the facets (torrents and streams alike: names
// that hold every word, quality, size; torrents also episodes, season, plays
// as is), the seed bars, the sources line, the actions.

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

/** The rail's facets for a list of offers (`torrents`: episodes, season, plays as is too) */
export function Facets({ all, filters, set, torrents, shows }: { all: Offer[]; filters: Filters; set: (p: Partial<Filters>) => void; torrents: boolean; shows: boolean }) {
  const count = (except: keyof Filters, test: (t: Offer) => boolean) => all.filter((t) => keep(t, filters, except) && test(t)).length
  const seasons = [...new Set(all.map((t) => t.season).filter((s): s is number => s != null))].sort((a, b) => a - b)
  return (
    <>
      <RailGroup title="Names">
        <RailItem label="Hold every word" count={count('loose', (t) => t.matches !== false)} active={!filters.loose} onClick={() => set({ loose: false })} />
        <RailItem label="Everything found" count={count('loose', () => true)} active={filters.loose} onClick={() => set({ loose: true })} />
      </RailGroup>
      <RailGroup title="Quality">
        <RailItem label="Any" count={count('quality', () => true)} active={!filters.quality} onClick={() => set({ quality: null })} />
        {QUALITIES.map((x) => ({ ...x, n: count('quality', (t) => qualityOf(t) === x.id) }))
          .filter((x) => x.n || filters.quality === x.id)
          .map((x) => (
            <RailItem key={x.id} label={x.label} count={x.n} active={filters.quality === x.id} onClick={() => set({ quality: x.id })} />
          ))}
      </RailGroup>
      <RailGroup title="Size">
        <RailItem label="Any" count={count('size', () => true)} active={!filters.size} onClick={() => set({ size: null })} />
        {SIZES.map((x) => (
          <RailItem key={x.id} label={x.label} count={count('size', (t) => !!t.size && x.test(t.size))} active={filters.size === x.id} onClick={() => set({ size: x.id })} />
        ))}
      </RailGroup>
      {torrents && shows && (
        <RailGroup title="Episodes">
          <RailItem label="Any" count={count('shape', () => true)} active={!filters.shape} onClick={() => set({ shape: null })} />
          <RailItem
            label="Single episodes"
            count={count('shape', (t) => !('pack' in t && t.pack) && t.episode != null)}
            active={filters.shape === 'episode'}
            onClick={() => set({ shape: 'episode' })}
          />
          <RailItem label="Season packs" count={count('shape', (t) => 'pack' in t && !!t.pack)} active={filters.shape === 'pack'} onClick={() => set({ shape: 'pack' })} />
        </RailGroup>
      )}
      {shows && seasons.length > 1 && (
        <RailGroup title="Season">
          <RailItem label="Any" count={count('season', () => true)} active={filters.season === null} onClick={() => set({ season: null })} />
          {seasons.map((s) => (
            <RailItem key={s} label={s === 0 ? 'Specials' : `Season ${s}`} count={count('season', (t) => t.season === s)} active={filters.season === s} onClick={() => set({ season: s })} />
          ))}
        </RailGroup>
      )}
      {torrents && (
        <RailGroup title="On Playpex TV">
          <RailItem label="Any" count={count('plays', () => true)} active={!filters.plays} onClick={() => set({ plays: false })} />
          <RailItem label="Plays as is" count={count('plays', playsAsIs)} active={filters.plays} onClick={() => set({ plays: true })} />
        </RailGroup>
      )}
    </>
  )
}

/** The facets on a phone: two selects */
export function PhoneFacets({ filters, set, torrents, shows }: { filters: Filters; set: (p: Partial<Filters>) => void; torrents: boolean; shows: boolean }) {
  return (
    <div className="flex gap-2">
      <Select value={filters.quality ?? 'any'} onValueChange={(v) => set({ quality: v === 'any' ? null : (v as Quality) })}>
        <SelectTrigger size="sm" aria-label="Quality" className="flex-1">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="any">Any quality</SelectItem>
          {QUALITIES.map((x) => (
            <SelectItem key={x.id} value={x.id}>
              {x.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={filters.shape ?? (filters.plays ? 'plays' : filters.loose ? 'loose' : 'any')}
        onValueChange={(v) => set({ shape: v === 'episode' || v === 'pack' ? v : null, plays: v === 'plays', loose: v === 'loose' })}
      >
        <SelectTrigger size="sm" aria-label="Narrow" className="flex-1">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Show</SelectLabel>
            <SelectItem value="any">Close matches</SelectItem>
            <SelectItem value="loose">Everything found</SelectItem>
            {torrents && <SelectItem value="plays">Plays as is on Playpex TV</SelectItem>}
            {torrents && shows && <SelectItem value="episode">Single episodes</SelectItem>}
            {torrents && shows && <SelectItem value="pack">Season packs</SelectItem>}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
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

/** Each source and how its part of the search went; a click leaves it out of the results (or back in) */
export function SourcesLine({ states, off, onToggle, extra }: { states: SourceState[]; off: string[]; onToggle: (id: string) => void; extra?: ReactNode }) {
  return (
    <div role="group" aria-label="Sources" className="flex flex-wrap items-center gap-1.5 text-sm">
      {extra}
      {states.map((s) => {
        const hidden = off.includes(s.source.id)
        return (
          <button
            key={s.source.group + s.source.id}
            type="button"
            aria-pressed={!hidden}
            onClick={() => onToggle(s.source.id)}
            title={s.state === 'failed' ? errorMessage(s.error) : hidden ? `Show ${s.source.name}'s results` : `Hide ${s.source.name}'s results`}
            className={cn(
              'inline-flex items-center gap-2 rounded-full border px-3 py-1 transition-colors hover:bg-muted',
              hidden ? 'border-dashed text-muted-foreground line-through decoration-muted-foreground/60' : 'bg-card',
            )}
          >
            <SourceDot state={s.state} found={s.count > 0} />
            <span className={cn(!hidden && 'text-foreground')}>{s.source.name}</span>
            <SourceCount state={s} />
          </button>
        )
      })}
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
  if (s.state === 'searching') return <span className="text-xs text-muted-foreground">searching</span>
  if (s.state === 'failed') return <span className="text-xs text-destructive">failed</span>
  if (s.state !== 'done') return null
  return (
    <>
      <span className="text-xs text-muted-foreground tabular-nums">{s.count || (s.loose ? 0 : 'nothing')}</span>
      {s.loose > 0 && (
        <span className="-ml-1 text-xs text-muted-foreground/70 tabular-nums" title={`${s.loose} more without every word in their name`}>
          +{s.loose} loose
        </span>
      )}
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
