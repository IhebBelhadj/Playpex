import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderOpen, HardDrive, Trash2 } from 'lucide-react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Confirm, Empty, Loading, Mono, PageHeader, QueryError, Stat } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, errorMessage, unwrap } from '@/lib/api'
import { ago, bytes } from '@/lib/format'

export function StoragePage() {
  const client = useQueryClient()
  const storage = useQuery({
    queryKey: ['storage'],
    queryFn: () => unwrap(api.GET('/admin/storage')),
    refetchInterval: 15_000,
  })
  const refresh = () => {
    client.invalidateQueries({ queryKey: ['storage'] })
    client.invalidateQueries({ queryKey: ['overview'] })
  }
  const remove = useMutation({
    mutationFn: (name: string) => unwrap(api.DELETE('/admin/storage/items/{name}', { params: { path: { name } } })),
    onSuccess: () => {
      toast.success('Deleted')
      refresh()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const clear = useMutation({
    mutationFn: () => unwrap(api.POST('/admin/storage/clear')),
    onSuccess: (r) => {
      toast.success(`${r.removed} entries deleted, ${bytes(r.freedBytes)} freed`)
      refresh()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  if (storage.isPending) return <Loading />
  if (storage.error) return <QueryError error={storage.error} />
  const s = storage.data
  const idle = s.items.filter((i) => !i.infoHash)
  const idleBytes = idle.reduce((sum, i) => sum + i.bytes, 0)
  const used = s.disk ? ((s.disk.total - s.disk.free) / s.disk.total) * 100 : 0

  return (
    <>
      <PageHeader
        title="Storage"
        description={<Mono className="text-xs">{s.dir}</Mono>}
        actions={
          <Confirm
            title="Delete everything not in use?"
            description={`${idle.length} entries (${bytes(idleBytes)}) that no running torrent uses are deleted from the download directory, and the downloads they belong to are forgotten. Playing them later downloads them again.`}
            action="Delete"
            onConfirm={() => clear.mutate()}
            trigger={
              <Button variant="outline" disabled={!idle.length || clear.isPending}>
                <Trash2 /> Clear unused
              </Button>
            }
          />
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Downloads" value={bytes(s.totalBytes)} hint={`${s.items.length} entries`} />
        <Stat label="Not in use" value={bytes(idleBytes)} hint={`${idle.length} entries`} />
        <Stat label="Free space" value={bytes(s.disk?.free)} hint={s.disk ? `of ${bytes(s.disk.total)}` : 'unknown'} />
        <Card size="sm">
          <CardHeader>
            <CardDescription>Disk used</CardDescription>
            <div className="font-mono text-2xl font-semibold tabular-nums">{used.toFixed(0)} %</div>
          </CardHeader>
          <CardContent>
            <Progress value={used} />
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FolderOpen className="size-4" /> Download directory
          </CardTitle>
          <CardDescription>
            One entry per torrent, largest first. Change the directory in{' '}
            <Link className="underline underline-offset-2" to="/settings/storage">
              Settings › Storage
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          {s.items.length === 0 ? (
            <Empty icon={<HardDrive />} title="Nothing downloaded" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">Modified</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.items.map((item) => (
                  <TableRow key={item.name}>
                    <TableCell className="w-full max-w-0">
                      <div className="flex items-center gap-2">
                        <Mono>{item.name}</Mono>
                        {item.infoHash && <Badge variant="secondary">in use</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs whitespace-nowrap">{bytes(item.bytes)}</TableCell>
                    <TableCell className="hidden text-right text-xs whitespace-nowrap text-muted-foreground sm:table-cell">
                      {ago(item.modifiedAt)}
                    </TableCell>
                    <TableCell>
                      <Confirm
                        title="Delete this download?"
                        description={item.download ? `${item.name}: its files, and the server forgets the download.` : item.name}
                        action="Delete"
                        onConfirm={() => remove.mutate(item.name)}
                        trigger={
                          <Button variant="ghost" size="icon-sm" aria-label={`Delete ${item.name}`} disabled={!!item.infoHash}>
                            <Trash2 />
                          </Button>
                        }
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  )
}
