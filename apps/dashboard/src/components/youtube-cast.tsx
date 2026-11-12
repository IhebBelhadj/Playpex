import { useQuery } from '@tanstack/react-query'
import { Smartphone, Tv } from 'lucide-react'
import { Dot, Loading, QueryError } from '@/components/common'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { api, unwrap } from '@/lib/api'

// Settings › Casting, under its switches: the Playpex screens in the YouTube
// app's Cast list now (GET /cast/youtube; apps/server/lib/cast/youtube.js) and
// the phones connected to each.

export function YouTubeCastPanel() {
  const query = useQuery({
    queryKey: ['cast-youtube'],
    queryFn: () => unwrap(api.GET('/cast/youtube')),
    refetchInterval: 10000,
  })
  if (query.isPending) return <Loading rows={2} />
  if (query.error) return <QueryError error={query.error} title="Could not load the YouTube Cast list" />
  const { enabled, receivers } = query.data
  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Dot state={enabled ? (receivers.length ? 'ok' : 'warn') : 'idle'} /> In the YouTube app
        </CardTitle>
        <CardDescription>
          {!enabled
            ? 'Off. Turn on “Show Playpex screens in the YouTube app’s Cast list” above, then save. It needs sharing on the local network.'
            : receivers.length
              ? `${receivers.length} screen${receivers.length === 1 ? '' : 's'} in the Cast list of phones on this network. A phone elsewhere links with the screen’s TV code (Playpex TV › Settings › Casting).`
              : 'No screen is on: open Playpex TV on a screen and it joins the Cast list.'}
        </CardDescription>
      </CardHeader>
      {enabled && receivers.length > 0 && (
        <CardContent>
          <ul className="divide-y overflow-hidden rounded-2xl bg-muted">
            {receivers.map((r) => (
              <li key={r.deviceId} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <Tv className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
                {r.senders.length ? (
                  <span className="flex items-center gap-1.5 text-gold">
                    <Smartphone className="size-3.5" /> {r.senders.join(', ')}
                  </span>
                ) : (
                  <span className="text-muted-foreground">No phone connected</span>
                )}
                <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">port {r.port}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            Phones find screens over SSDP (UDP port 1900) and reach them on TCP ports from 28473: allow them in the firewall if the YouTube app doesn’t
            list them.
          </p>
        </CardContent>
      )}
    </Card>
  )
}
