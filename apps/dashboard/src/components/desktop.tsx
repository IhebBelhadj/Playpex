import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Confirm, QueryError, Spinner } from '@/components/common'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { api, errorMessage, unwrap, type DesktopState, type HostInfo } from '@/lib/api'
import { ago } from '@/lib/format'

// The desktop app (apps/server-desktop) that runs the server with a tray
// icon: its own settings (start at login, updates), through /admin/host.
// Nothing here shows on a headless server.

export function useHost() {
  return useQuery({ queryKey: ['host'], queryFn: () => unwrap(api.GET('/admin/host')), staleTime: 30_000 })
}

function updateLine(u: DesktopState['update']): string {
  switch (u.state) {
    case 'unsupported':
      return 'This build can’t update itself (a development run, or a Linux package without updater support).'
    case 'checking':
      return 'Checking for updates…'
    case 'available':
    case 'downloading':
      return `Downloading ${u.version ?? 'the update'}…`
    case 'downloaded':
      return `Version ${u.version} is downloaded and ready to install.`
    case 'none':
      return `Up to date${u.checkedAt ? ` (checked ${ago(u.checkedAt)})` : ''}.`
    case 'error':
      return `The last check failed: ${u.error ?? 'unknown error'}`
    default:
      return 'Not checked yet.'
  }
}

function useInstall() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (force: boolean) => unwrap(api.POST('/admin/host/update/install', { body: { force } })),
    onSuccess: () => {
      toast.success('Installing: the server restarts in a moment')
      client.invalidateQueries()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
}

function InstallButton({ version, streams }: { version?: string | null; streams: number }) {
  const install = useInstall()
  const label = (
    <>
      {install.isPending ? <Spinner /> : <Download />} Install {version} and restart
    </>
  )
  if (!streams) {
    return (
      <Button size="sm" disabled={install.isPending} onClick={() => install.mutate(false)}>
        {label}
      </Button>
    )
  }
  return (
    <Confirm
      trigger={
        <Button size="sm" disabled={install.isPending}>
          {label}
        </Button>
      }
      title={`Install ${version} now?`}
      description={`${streams === 1 ? '1 stream is' : `${streams} streams are`} playing. Installing restarts the server and stops them.`}
      action="Install and restart"
      onConfirm={() => install.mutate(true)}
    />
  )
}

/** The Settings tab "Desktop app". */
export function DesktopCard({ streams }: { streams: number }) {
  const client = useQueryClient()
  const host = useHost()
  const change = useMutation({
    mutationFn: (patch: { openAtLogin?: boolean; checkForUpdates?: boolean }) => unwrap(api.PUT('/admin/host', { body: patch })),
    onSuccess: (r) => client.setQueryData(['host'], r),
    onError: (err) => toast.error(errorMessage(err)),
  })
  const check = useMutation({
    mutationFn: () => unwrap(api.POST('/admin/host/update/check')),
    onSuccess: (r) => client.setQueryData(['host'], r),
    onError: (err) => toast.error(errorMessage(err)),
  })
  if (host.error) return <QueryError error={host.error} />
  const d = host.data?.desktop
  if (!d) return null
  const u = d.update
  const busy = u.state === 'checking' || u.state === 'available' || u.state === 'downloading'
  return (
    <Card>
      <CardHeader>
        <CardTitle>Desktop app</CardTitle>
        <CardDescription>
          Playpex Media Server {d.appVersion} runs this server in the background, with an icon in the {d.platform === 'darwin' ? 'menu bar' : 'notification area'}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="openAtLogin">Start at login</Label>
            <p className="text-xs text-muted-foreground">Starts hidden, in the tray, when you log in to this computer.</p>
          </div>
          <Switch id="openAtLogin" checked={d.openAtLogin} disabled={change.isPending} onCheckedChange={(v) => change.mutate({ openAtLogin: v })} />
        </div>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="checkForUpdates">Check for updates automatically</Label>
            <p className="text-xs text-muted-foreground">At start and every 6 hours. Updates download in the background and never install during a stream.</p>
          </div>
          <Switch
            id="checkForUpdates"
            checked={d.checkForUpdates}
            disabled={change.isPending || u.state === 'unsupported'}
            onCheckedChange={(v) => change.mutate({ checkForUpdates: v })}
          />
        </div>
        <div className="space-y-2 rounded-2xl bg-muted p-4">
          <p className="text-sm">{updateLine(u)}</p>
          {u.state === 'downloading' && u.percent !== null && <Progress value={u.percent} />}
          <div className="flex flex-wrap gap-2">
            {u.state === 'downloaded' ? (
              <InstallButton version={u.version} streams={streams} />
            ) : (
              <Button size="sm" variant="outline" disabled={busy || check.isPending || u.state === 'unsupported'} onClick={() => check.mutate()}>
                {busy || check.isPending ? <Spinner /> : <RefreshCw />} Check now
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

/** On the Overview: a downloaded update, ready to install. */
export function UpdateNotice({ host, streams }: { host: HostInfo | undefined; streams: number }) {
  const u = host?.desktop?.update
  if (!u || u.state !== 'downloaded') return null
  return (
    <Alert>
      <Download />
      <AlertTitle>Update {u.version} is ready</AlertTitle>
      <AlertDescription>
        <p>It installs when you choose it here or in the tray, or the next time Playpex Media Server quits.</p>
        <div className="mt-2">
          <InstallButton version={u.version} streams={streams} />
        </div>
      </AlertDescription>
    </Alert>
  )
}
