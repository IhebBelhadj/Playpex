import { Check, Download as DownloadIcon, Film, Play, Plus, Radio } from 'lucide-react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { qualityOf, Seeds, useSearchActions } from '@/components/search/parts'
import { Button } from '@/components/ui/button'
import { bytes } from '@/lib/format'
import { episodeCode } from '@/lib/media'
import type { Release, StreamItem } from '@/lib/search'
import { cn } from '@/lib/utils'

// Search's rows: streams and files (Play, Download), torrents in the overview and
// on phones (Add). The name, one line of what it is (episode, quality, size,
// where from), a torrent's seeds, one action.

function Row({ thumb, name, meta, side, actions, dim }: { thumb?: ReactNode; name: string; meta: ReactNode; side?: ReactNode; actions: ReactNode; dim?: boolean }) {
  return (
    <li className={cn('flex items-center gap-3 px-4 py-3', dim && 'opacity-60')}>
      {thumb}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" title={name}>
          {name}
        </div>
        <div className="mt-0.5 truncate text-[13px] text-muted-foreground">{meta}</div>
      </div>
      {side && <div className="hidden shrink-0 text-sm tabular-nums sm:block">{side}</div>}
      <div className="flex shrink-0 items-center gap-1">{actions}</div>
    </li>
  )
}

/** What Playpex reads in a name, then quality, size and where it comes from: one line */
const line = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(', ')
const quality = (q: string) => (q === 'unknown' ? null : q)

export function StreamRows({ items, sourceName }: { items: StreamItem[]; sourceName: (provider: string) => string }) {
  const act = useSearchActions()
  return (
    <ul className="divide-y overflow-hidden rounded-xl bg-card">
      {items.map((s) => {
        // what it is first (a provider's title), its file's name under it
        const what = s.title ? `${s.title}${s.year ? ` (${s.year})` : ''}` : null
        const meta = line(
          s.season != null && s.episode != null ? episodeCode(s.season, s.episode) : null,
          quality(qualityOf(s)),
          s.size ? bytes(s.size) : null,
          s.kind === 'hls' ? 'stream' : s.kind === 'torrent' ? 'torrent' : null,
          s.audio === 'unsupported' ? 'Dolby or DTS sound' : null,
          sourceName(s.provider),
          what && what !== s.label ? s.label : null,
        )
        return (
          <Row
            key={s.ref ?? s.infoHash ?? s.label}
            dim={s.matches === false}
            thumb={
              <span className="flex h-12 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
                {s.poster ? <img src={s.poster} alt="" loading="lazy" className="size-full object-cover" /> : s.kind === 'hls' ? <Radio className="size-4 text-muted-foreground" /> : <Film className="size-4 text-muted-foreground" />}
              </span>
            }
            name={what ?? s.label}
            meta={meta}
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
    <ul className="divide-y overflow-hidden rounded-xl bg-card">
      {releases.map((t) => {
        const meta = line(
          t.pack && t.season != null ? `Season ${t.season}, whole` : null,
          !t.pack && t.season != null && t.episode != null ? episodeCode(t.season, t.episode) : null,
          quality(qualityOf(t)),
          t.size ? bytes(t.size) : null,
          t.audio === 'unsupported' ? 'Dolby or DTS sound' : null,
          sourceName(t),
        )
        return (
          <Row
            key={t.hash}
            dim={t.matches === false}
            name={t.name}
            meta={kept.has(t.hash) ? <><span className="text-up">In Downloads</span>, {meta}</> : meta}
            side={<Seeds seeds={t.seeds} />}
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
