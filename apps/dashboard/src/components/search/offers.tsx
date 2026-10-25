import { Check, Download as DownloadIcon, Film, Play, Plus, Radio } from 'lucide-react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { qualityOf, Seeds, useSearchActions } from '@/components/search/parts'
import { Button } from '@/components/ui/button'
import { bytes } from '@/lib/format'
import { episodeCode } from '@/lib/media'
import type { Release, StreamItem } from '@/lib/search'
import { cn } from '@/lib/utils'

// Search's compact rows: streams and files (Play, Download), torrents in the
// overview and on phones (Add, Add and start). One line of name, one of what
// Playpex reads in it; numbers on the right.

function Row({
  thumb,
  name,
  reading,
  numbers,
  source,
  actions,
  dim,
}: {
  thumb?: ReactNode
  name: string
  reading: ReactNode
  numbers: ReactNode
  source: string
  actions: ReactNode
  dim?: boolean
}) {
  return (
    <li className={cn('flex items-center gap-3 px-3 py-2', dim && 'opacity-70')}>
      {thumb}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" title={name}>
          {name}
        </div>
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">{reading}</div>
      </div>
      <div className="hidden shrink-0 items-center gap-4 text-sm tabular-nums sm:flex">{numbers}</div>
      <span className="hidden w-28 shrink-0 truncate text-sm text-muted-foreground lg:block" title={source}>
        {source}
      </span>
      <div className="flex shrink-0 items-center gap-1">{actions}</div>
    </li>
  )
}

function Quality({ value }: { value: string }) {
  return <span className="w-12 text-right">{value === 'unknown' ? <span className="text-muted-foreground">—</span> : value}</span>
}

export function StreamRows({ items, sourceName }: { items: StreamItem[]; sourceName: (provider: string) => string }) {
  const act = useSearchActions()
  return (
    <ul className="divide-y rounded-lg border">
      {items.map((s) => {
        // what it is first (a provider's title), its file's name under it
        const what = s.title ? `${s.title}${s.year ? ` (${s.year})` : ''}` : null
        const reading = [
          what && what !== s.label ? s.label : null,
          s.season != null && s.episode != null ? episodeCode(s.season, s.episode) : null,
          s.kind === 'hls' ? 'Stream (HLS)' : s.kind === 'torrent' ? 'Torrent' : 'File',
          s.codec,
          s.audio === 'unsupported' ? 'Dolby or DTS sound' : null,
        ].filter(Boolean)
        return (
          <Row
            key={s.ref ?? s.infoHash ?? s.label}
            dim={s.matches === false}
            thumb={
              <span className="flex h-12 w-8 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
                {s.poster ? <img src={s.poster} alt="" loading="lazy" className="size-full object-cover" /> : s.kind === 'hls' ? <Radio className="size-4 text-muted-foreground" /> : <Film className="size-4 text-muted-foreground" />}
              </span>
            }
            name={what ?? s.label}
            reading={
              <>
                <span className="truncate">{reading.join(', ')}</span>
                {s.matches === false && <span className="shrink-0">not every word</span>}
              </>
            }
            numbers={
              <>
                <Quality value={qualityOf(s)} />
                <span className="w-16 text-right">{s.size ? bytes(s.size) : <span className="text-muted-foreground">—</span>}</span>
              </>
            }
            source={sourceName(s.provider)}
            actions={
              s.kind === 'torrent' ? (
                <Button variant="ghost" size="xs" onClick={() => s.magnet && act.startTorrent(s.magnet, s.label)}>
                  <Plus /> Add
                </Button>
              ) : (
                <>
                  <Button variant="ghost" size="xs" onClick={() => s.ref && act.play(s.ref, s.title ?? s.label, s.title ? s.label : undefined)}>
                    <Play /> Play
                  </Button>
                  <Button variant="ghost" size="icon-xs" aria-label="Download to the server" title="Download to the server" disabled={act.downloading} onClick={() => s.ref && act.download(s.ref)}>
                    <DownloadIcon />
                  </Button>
                </>
              )
            }
          />
        )
      })}
    </ul>
  )
}

export function TorrentRows({ releases, kept, sourceName, onAdd }: { releases: Release[]; kept: Set<string>; sourceName: (t: Release) => string; onAdd: (t: Release) => void }) {
  const navigate = useNavigate()
  return (
    <ul className="divide-y rounded-lg border">
      {releases.map((t) => {
        const reading = [
          t.title ? `${t.title}${t.year ? ` (${t.year})` : ''}` : null,
          t.pack && t.season != null ? `Season ${t.season}, whole` : null,
          !t.pack && t.season != null && t.episode != null ? episodeCode(t.season, t.episode) : null,
          t.audio === 'unsupported' ? 'Dolby or DTS sound' : null,
        ].filter(Boolean)
        return (
          <Row
            key={t.hash}
            dim={t.matches === false}
            name={t.name}
            reading={
              <>
                {kept.has(t.hash) && <span className="shrink-0 text-up">In Downloads</span>}
                <span className="truncate">{reading.join(', ')}</span>
              </>
            }
            numbers={
              <>
                <Quality value={qualityOf(t)} />
                <span className="w-16 text-right">{t.size ? bytes(t.size) : <span className="text-muted-foreground">—</span>}</span>
                <span className="w-16">
                  <Seeds seeds={t.seeds} />
                </span>
              </>
            }
            source={sourceName(t)}
            actions={
              kept.has(t.hash) ? (
                <Button variant="ghost" size="xs" className="text-up" onClick={() => navigate(`/downloads?hash=${t.hash}`)}>
                  <Check /> Kept
                </Button>
              ) : (
                <Button variant="ghost" size="xs" onClick={() => onAdd(t)}>
                  <Plus /> Add
                </Button>
              )
            }
          />
        )
      })}
    </ul>
  )
}
