import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, RefreshCw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Empty, Loading, QueryError, Stat } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { API_PREFIX, api, errorMessage, unwrap } from '@/lib/api'
import { ago } from '@/lib/format'

// A live plugin's channels (docs/providers-plan.md §8, step 9): what the
// server keeps of its live.channels (GET /admin/plugins/{id}/channels, key
// ['admin-plugin-channels', id]), how long they took, its last error, the
// groups; Refresh asks it again now. Clients get them through /live/*.

const SHOWN = 300

export function PluginChannels({ plugin, enabled }: { plugin: string; enabled: boolean }) {
  const client = useQueryClient()
  const [q, setQ] = useState('')
  const [group, setGroup] = useState<string | null>(null)
  const query = useQuery({
    queryKey: ['admin-plugin-channels', plugin],
    queryFn: () => unwrap(api.GET('/admin/plugins/{pluginId}/channels', { params: { path: { pluginId: plugin } } })),
    enabled,
  })
  const refresh = useMutation({
    mutationFn: () => unwrap(api.POST('/admin/plugins/{pluginId}/channels/refresh', { params: { path: { pluginId: plugin } } })),
    onSuccess: (data) => {
      client.setQueryData(['admin-plugin-channels', plugin], data)
      toast.success(`${data.channels ?? 0} channels`)
    },
    onError: (err) => toast.error('Refresh failed', { description: errorMessage(err) }),
  })
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return (query.data?.list ?? []).filter(
      (c) =>
        (!group || c.group === group) &&
        words.every((w) => `${c.name} ${c.number} ${c.group ?? ''}`.toLowerCase().includes(w)),
    )
  }, [query.data, q, group])

  if (!enabled) return <Empty title="Switched off">Switch it on to see its channels.</Empty>
  if (query.isPending) return <Loading />
  if (query.error) return <QueryError error={query.error} title="Could not load its channels" />
  const data = query.data

  return (
    <div className="space-y-4 pt-2">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Channels" value={data.channels ?? '—'} />
        <Stat label="Groups" value={data.groups.length} />
        <Stat label="Programme guide" value={data.guide ? 'Yes' : 'No'} />
        <Stat label="Updated" value={data.updatedAt ? ago(data.updatedAt) : 'Never'} hint={data.durationMs != null ? `in ${(data.durationMs / 1000).toFixed(1)} s` : undefined} />
      </div>
      {data.error && (
        <p className="flex items-start gap-1.5 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {data.error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Name, number or group" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Button variant="outline" size="sm" disabled={refresh.isPending || data.refreshing} onClick={() => refresh.mutate()}>
          <RefreshCw className={refresh.isPending ? 'animate-spin' : ''} /> Refresh
        </Button>
      </div>
      {data.groups.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <Badge variant={group ? 'outline' : 'default'} className="cursor-pointer" onClick={() => setGroup(null)}>
            All {data.channels}
          </Badge>
          {data.groups.map((g) => (
            <Badge key={g.name} variant={group === g.name ? 'default' : 'outline'} className="cursor-pointer" onClick={() => setGroup(g.name)}>
              {g.name} {g.count}
            </Badge>
          ))}
        </div>
      )}
      {!list.length ? (
        <Empty title="No channels">
          {data.list.length ? 'None matches.' : 'It lists none: check its settings (a playlist address?).'}
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16 text-right">#</TableHead>
              <TableHead className="w-14" />
              <TableHead>Name</TableHead>
              <TableHead>Group</TableHead>
              <TableHead className="hidden md:table-cell">Id</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.slice(0, SHOWN).map((c) => (
              <TableRow key={c.id}>
                <TableCell className="text-right font-mono tabular-nums">{c.number}</TableCell>
                <TableCell>
                  {c.logo && <img src={c.logo.startsWith('/') ? API_PREFIX + c.logo : c.logo} alt="" className="h-6 w-10 object-contain" loading="lazy" />}
                </TableCell>
                <TableCell className="font-medium">
                  {c.name} {c.audience === 'adults' && <Badge variant="outline">Adults</Badge>}
                </TableCell>
                <TableCell className="text-muted-foreground">{c.group}</TableCell>
                <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">{c.id}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {list.length > SHOWN && <p className="text-xs text-muted-foreground">The first {SHOWN} of {list.length}: search to find the others.</p>}
    </div>
  )
}
