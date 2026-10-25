import { useQuery } from '@tanstack/react-query'
import { Copy, Download as DownloadIcon, FileVideo, Link2, Magnet, Play, Plus, Radio, SearchX } from 'lucide-react'
import type { ReactNode } from 'react'
import { Empty, Spinner } from '@/components/common'
import { useSearchActions } from '@/components/search/parts'
import { Button } from '@/components/ui/button'
import { api, errorMessage, unwrap, type Schemas } from '@/lib/api'
import { bytes } from '@/lib/format'

// Search with a link in the field (docs/search-plan.md §4): the server reads
// it (POST /admin/links/inspect) and says what it is, or what a page links to.
// Each thing gets the actions it can take: a video or a stream plays and
// downloads to the server, a magnet or a .torrent becomes a torrent download.

type Item = Schemas['LinkItem']

const KINDS: { kind: Item['kind']; title: string; icon: ReactNode; hint: string }[] = [
  { kind: 'video', title: 'Video files', icon: <FileVideo className="size-4" />, hint: 'Played and downloaded through the server' },
  { kind: 'hls', title: 'Streams', icon: <Radio className="size-4" />, hint: 'HLS playlists: downloading saves the whole stream with ffmpeg' },
  { kind: 'torrent', title: 'Torrent files', icon: <Link2 className="size-4" />, hint: 'Added to Downloads' },
  { kind: 'magnet', title: 'Magnet links', icon: <Magnet className="size-4" />, hint: 'Added to Downloads' },
]

const WHAT: Record<string, string> = { page: 'A web page', video: 'A video file', hls: 'A stream', torrent: 'A torrent file', magnet: 'A magnet link' }

function hostOf(url: string) {
  try {
    return new URL(url).host
  } catch {
    return url.startsWith('magnet:') ? 'magnet link' : url
  }
}

export function LinkView({ url, onAdd }: { url: string; onAdd: (link: string, name: string) => void }) {
  const act = useSearchActions()
  const inspected = useQuery({
    queryKey: ['link-inspect', url],
    retry: false,
    staleTime: 10 * 60_000,
    queryFn: () => unwrap(api.POST('/admin/links/inspect', { body: { url } })),
  })

  if (inspected.isPending) {
    return (
      <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Spinner /> Reading {hostOf(url)}…
      </p>
    )
  }
  if (inspected.error) {
    return (
      <Empty icon={<SearchX />} title="The server couldn’t read this link">
        {errorMessage(inspected.error)}
      </Empty>
    )
  }
  const page = inspected.data
  const groups = KINDS.map((k) => ({ ...k, items: page.items.filter((i) => i.kind === k.kind) })).filter((g) => g.items.length)

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">
          {WHAT[page.kind]} on {hostOf(page.url)}
          {page.kind === 'page' && `, linking to ${page.items.length} ${page.items.length === 1 ? 'thing' : 'things'} Playpex can use`}
        </p>
        {page.title && <h2 className="text-xl font-semibold tracking-tight">{page.title}</h2>}
      </div>

      {groups.length === 0 ? (
        <Empty icon={<SearchX />} title="Nothing to play or download here">
          The page links to no video file, stream, magnet or .torrent the server could see. Players a page builds with scripts after it loads stay
          hidden from it: open the video’s own address and paste that.
        </Empty>
      ) : (
        groups.map((g) => (
          <section key={g.kind} className="space-y-2">
            <div className="flex items-baseline gap-2">
              <span className="self-center text-muted-foreground">{g.icon}</span>
              <h3 className="text-base font-semibold tracking-tight">{g.title}</h3>
              <span className="text-sm text-muted-foreground tabular-nums">{g.items.length}</span>
              <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">{g.hint}</span>
            </div>
            <ul className="divide-y rounded-lg border">
              {g.items.map((item) => (
                <li key={item.kind + item.url} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium" title={item.label}>
                      {item.label}
                    </div>
                    <div className="truncate text-xs text-muted-foreground" title={item.url}>
                      {[item.size ? bytes(item.size) : null, item.kind === 'magnet' ? item.infoHash : hostOf(item.url)].filter(Boolean).join(', ')}
                    </div>
                  </div>
                  {item.ref ? (
                    <>
                      <Button variant="ghost" size="xs" onClick={() => act.play(item.ref!, item.label, hostOf(item.url))}>
                        <Play /> Play
                      </Button>
                      <Button variant="ghost" size="xs" disabled={act.downloading} onClick={() => act.download(item.ref!)}>
                        <DownloadIcon /> Download
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button variant="ghost" size="xs" onClick={() => onAdd(item.url, item.label)}>
                        <Plus /> Add…
                      </Button>
                      <Button variant="ghost" size="xs" onClick={() => act.startTorrent(item.url, item.label)}>
                        <DownloadIcon /> Add and start
                      </Button>
                    </>
                  )}
                  <Button variant="ghost" size="icon-xs" aria-label="Copy the link" title="Copy the link" onClick={() => act.copy(item.url, 'Link')}>
                    <Copy />
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      {page.truncated && <p className="text-xs text-muted-foreground">The page is longer than the server reads (2 MB): links after that point aren’t listed.</p>}
    </div>
  )
}
