import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, KeyRound, MonitorSmartphone, Pencil, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Confirm, Dot, Empty, Loading, PageHeader, QueryError } from '@/components/common'
import { usePairingRequests } from '@/components/layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, errorMessage, unwrap, type Device, type PairingRequest } from '@/lib/api'
import { ago } from '@/lib/format'

/** "ABCD1234" → "ABCD-1234" (how clients show it) */
export function formatCode(code: string) {
  const c = code.replace(/[^a-z0-9]/gi, '').toUpperCase()
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c
}

export function usePairingDecision() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ code, approve }: { code: string; approve: boolean }) =>
      unwrap(
        approve
          ? api.POST('/admin/pairing/{code}/approve', { params: { path: { code } } })
          : api.POST('/admin/pairing/{code}/deny', { params: { path: { code } } }),
      ),
    onSuccess: (_, { approve }) => {
      toast.success(approve ? 'Device approved: it connects within a few seconds' : 'Request denied')
      client.invalidateQueries({ queryKey: ['pairing'] })
      client.invalidateQueries({ queryKey: ['devices'] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
}

export function PairingRequests({ requests, highlight }: { requests: PairingRequest[]; highlight?: string }) {
  const decide = usePairingDecision()
  if (!requests.length) {
    return <p className="text-sm text-muted-foreground">No device is waiting. When a client shows a code, it appears here.</p>
  }
  return (
    <div className="space-y-2">
      {requests.map((r) => {
        const mine = highlight && formatCode(highlight) === formatCode(r.userCode)
        return (
          <div
            key={r.userCode}
            className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3 ${mine ? 'bg-accent ring-1 ring-foreground/40' : 'bg-muted'}`}
          >
            <div className="min-w-0">
              <div className="font-mono text-lg tracking-widest">{formatCode(r.userCode)}</div>
              <div className="text-xs text-muted-foreground">
                {r.client ?? r.clientId ?? 'Unknown client'} · {r.address ?? 'unknown address'} · asked {ago(r.requestedAt)} · expires{' '}
                {ago(r.expiresAt)}
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate({ code: r.userCode, approve: false })}>
                <X /> Deny
              </Button>
              <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ code: r.userCode, approve: true })}>
                <Check /> Approve
              </Button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function RenameDialog({ device, onClose }: { device: Device | null; onClose: () => void }) {
  const client = useQueryClient()
  const [name, setName] = useState('')
  const rename = useMutation({
    mutationFn: () => unwrap(api.PUT('/admin/devices/{id}', { params: { path: { id: device!.id } }, body: { name: name.trim() } })),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['devices'] })
      onClose()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <Dialog open={!!device} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        onOpenAutoFocus={() => setName(device?.name ?? '')}
      >
        <DialogHeader>
          <DialogTitle>Rename device</DialogTitle>
        </DialogHeader>
        <form
          id="rename"
          onSubmit={(e) => {
            e.preventDefault()
            rename.mutate()
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} required autoFocus />
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="rename" disabled={rename.isPending || !name.trim()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function capabilities(device: Device) {
  const c = device.capabilities as { video?: string[]; audio?: string[]; maxHeight?: number } | null
  if (!c) return null
  return [c.video?.join(', '), c.audio?.join(', '), c.maxHeight ? `${c.maxHeight}p` : null].filter(Boolean).join(' · ')
}

export function DevicesPage() {
  const client = useQueryClient()
  const pairing = usePairingRequests()
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () => unwrap(api.GET('/admin/devices')).then((r) => r.devices),
    refetchInterval: 30_000,
  })
  const [renaming, setRenaming] = useState<Device | null>(null)
  const revoke = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE('/admin/devices/{id}', { params: { path: { id } } })),
    onSuccess: () => {
      toast.success('Device revoked')
      client.invalidateQueries({ queryKey: ['devices'] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  return (
    <>
      <PageHeader
        title="Devices"
        description="Clients on your network pair with this server once; clients on this machine don't need to."
        actions={
          <Button asChild variant="outline">
            <Link to="/link">
              <KeyRound /> Enter a code
            </Link>
          </Button>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>Waiting for approval</CardTitle>
          <CardDescription>Approve only codes shown on a device you own.</CardDescription>
        </CardHeader>
        <CardContent>
          {pairing.error ? <QueryError error={pairing.error} /> : pairing.isPending ? <Loading rows={1} /> : <PairingRequests requests={pairing.data} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Paired devices</CardTitle>
        </CardHeader>
        <CardContent>
          {devices.isPending ? (
            <Loading rows={2} />
          ) : devices.error ? (
            <QueryError error={devices.error} />
          ) : devices.data.length === 0 ? (
            <Empty icon={<MonitorSmartphone />} title="No paired devices">
              Open Playpex on a TV or phone on your network and pick this server: it shows a code to approve here.
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Device</TableHead>
                  <TableHead className="hidden md:table-cell">Client</TableHead>
                  <TableHead className="hidden sm:table-cell">Last seen</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.data.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Dot state={d.online ? 'ok' : 'idle'} />
                        <span className="font-medium">{d.name ?? 'Unnamed device'}</span>
                        {d.online && <Badge variant="secondary">online</Badge>}
                      </div>
                      <div className="mt-0.5 pl-4 text-xs text-muted-foreground">
                        {[d.platform, d.address].filter(Boolean).join(' · ') || d.clientId}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <div className="text-sm">{d.client ?? d.clientId}</div>
                      {capabilities(d) && <div className="text-xs text-muted-foreground">{capabilities(d)}</div>}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      <div>{ago(d.lastSeenAt)}</div>
                      <div className="text-xs">paired {ago(d.createdAt)}</div>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon-sm" aria-label="Rename" onClick={() => setRenaming(d)}>
                          <Pencil />
                        </Button>
                        <Confirm
                          title={`Revoke ${d.name ?? 'this device'}?`}
                          description="Its token stops working at once and what it plays stops. To use the server again it has to pair again."
                          action="Revoke"
                          onConfirm={() => revoke.mutate(d.id)}
                          trigger={
                            <Button variant="ghost" size="icon-sm" aria-label="Revoke">
                              <Trash2 />
                            </Button>
                          }
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <RenameDialog device={renaming} onClose={() => setRenaming(null)} />
    </>
  )
}
