import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Film, Folder, HardDrive, Tv } from 'lucide-react'
import { toast } from 'sonner'
import { Dot, Empty, Loading, Mono, QueryError } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { api, errorMessage, unwrap, type Schemas } from '@/lib/api'
import { ago } from '@/lib/format'

// Settings › DLNA, below the switch and the port: whether the DLNA server
// runs (GET /admin/dlna), which library folders it serves, and the TVs and
// players that used it in the last day (apps/server/lib/dlna).

type DlnaStatus = Schemas['DlnaStatus']
type DlnaFolder = DlnaStatus['folders'][number]

const REASONS: Record<string, string> = {
  disabled: 'Off. Turn it on above, then save.',
  lanSharing: 'Off: it needs “Share on the local network” (Settings › Network).',
  recovery: 'Off while the server is in recovery mode.',
}

function state(status: DlnaStatus): { dot: 'ok' | 'warn' | 'bad' | 'idle'; text: string } {
  if (!status.enabled) return { dot: 'idle', text: REASONS[status.reason ?? 'disabled'] ?? 'Off' }
  if (status.http.state === 'error') return { dot: 'bad', text: `Not running: ${status.http.error}` }
  if (status.http.state !== 'listening') return { dot: 'warn', text: 'Starting…' }
  if (status.ssdp.state === 'error') return { dot: 'warn', text: `Serving on port ${status.http.port}, but devices can’t find it by themselves: ${status.ssdp.error}` }
  return { dot: 'ok', text: `“${status.name}” is on the network (port ${status.http.port})` }
}

export function DlnaPanel() {
  const query = useQuery({
    queryKey: ['dlna'],
    queryFn: () => unwrap(api.GET('/admin/dlna')),
    refetchInterval: 10000,
  })
  if (query.isPending) return <Loading rows={3} />
  if (query.error) return <QueryError error={query.error} title="Could not load the DLNA status" />
  const status = query.data
  const s = state(status)
  return (
    <div className="mt-6 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Dot state={s.dot} /> Status
          </CardTitle>
          <CardDescription>{s.text}</CardDescription>
        </CardHeader>
        {status.http.state === 'listening' && (
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Shown now: {status.shown.movies} movie{status.shown.movies === 1 ? '' : 's'}, {status.shown.shows} show
              {status.shown.shows === 1 ? '' : 's'}, {status.shown.files} file{status.shown.files === 1 ? '' : 's'} in all. Allow UDP port 1900 and TCP
              port {status.http.port} in the firewall if TVs don’t list it.
            </p>
            {status.urls.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Device description</div>
                {status.urls.map((url) => (
                  <Mono key={url} className="block truncate text-xs">
                    {url}
                  </Mono>
                ))}
              </div>
            )}
          </CardContent>
        )}
      </Card>
      <FolderCard folders={status.folders} />
      <SeenCard renderers={status.renderers} />
    </div>
  )
}

function FolderCard({ folders }: { folders: DlnaFolder[] }) {
  const client = useQueryClient()
  const toggle = useMutation({
    mutationFn: (f: { id: string; dlna: boolean }) => unwrap(api.PATCH('/admin/library/folders/{id}', { params: { path: { id: f.id } }, body: { dlna: f.dlna } })),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['dlna'] })
      client.invalidateQueries({ queryKey: ['library'] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle>Folders</CardTitle>
        <CardDescription>
          The library folders TVs may browse (Movies, TV shows, Recently added and the folders as they are on disk).
          {folders.some((f) => f.audience === 'adults') && ' Adults-only folders never are: DLNA has no profiles and no pairing.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {folders.length === 0 ? (
          <div className="px-6">
            <Empty icon={<Folder />} title="No library folders">
              Add folders in Library first.
            </Empty>
          </div>
        ) : (
          <div className="divide-y border-t">
            {folders.map((f) => {
              const Icon = f.builtin ? HardDrive : f.kind === 'shows' ? Tv : f.kind === 'movies' ? Film : Folder
              const adults = f.audience === 'adults'
              return (
                <label key={f.id} htmlFor={`dlna-${f.id}`} className="flex items-center gap-3 px-6 py-3">
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{f.name}</div>
                    <div className="truncate font-mono text-xs text-muted-foreground" title={f.path}>
                      {f.path}
                    </div>
                  </div>
                  <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">
                    {f.files} file{f.files === 1 ? '' : 's'}
                  </span>
                  {adults && <Badge variant="outline">Adults only</Badge>}
                  <Switch
                    id={`dlna-${f.id}`}
                    checked={f.dlna && !adults}
                    disabled={adults || toggle.isPending}
                    onCheckedChange={(dlna) => toggle.mutate({ id: f.id, dlna })}
                  />
                </label>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function SeenCard({ renderers }: { renderers: DlnaStatus['renderers'] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Seen by</CardTitle>
        <CardDescription>Devices that browsed or played in the last day.</CardDescription>
      </CardHeader>
      <CardContent>
        {renderers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No device yet.</p>
        ) : (
          <ul className="divide-y">
            {renderers.map((r) => (
              <li key={r.address} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2 text-sm first:pt-0 last:pb-0">
                <span className="font-medium">{r.name ?? r.address}</span>
                {r.name && <span className="font-mono text-xs text-muted-foreground">{r.address}</span>}
                <span className="ml-auto text-xs text-muted-foreground">
                  {r.lastPlayedAt ? `played ${ago(r.lastPlayedAt)}` : `browsed ${ago(r.lastSeenAt)}`}
                </span>
                {r.userAgent && <span className="w-full truncate font-mono text-xs text-muted-foreground">{r.userAgent}</span>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
