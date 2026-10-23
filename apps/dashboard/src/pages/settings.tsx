import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, Lock, RotateCw, Save, Undo2 } from 'lucide-react'
import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { Loading, PageHeader, QueryError, Spinner } from '@/components/common'
import { DesktopCard, useHost } from '@/components/desktop'
import { DlnaPanel } from '@/components/dlna'
import { useOverview } from '@/components/layout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, errorMessage, unwrap, type SettingsView } from '@/lib/api'
import { bytes } from '@/lib/format'
import { restartServer } from '@/lib/restart'

// Every server setting (apps/server/lib/settings.js, plan §5.3), grouped in
// tabs. Values locked by an environment variable are shown read-only.

type Kind = 'text' | 'number' | 'switch' | 'list' | 'secret' | 'level' | 'port' | 'dir' | 'engine'

interface Field {
  key: string
  label: string
  help?: ReactNode
  kind: Kind
  placeholder?: string
  min?: number
  step?: number
}

const GROUPS: { id: string; title: string; description: string; fields: Field[] }[] = [
  {
    id: 'general',
    title: 'General',
    description: 'How the server presents itself and what it logs.',
    fields: [
      { key: 'general.serverName', label: 'Server name', kind: 'text', help: 'Shown by clients when they find this server.' },
      { key: 'general.port', label: 'HTTP port', kind: 'port', help: 'Clients, streams and this dashboard. Default 28470. Applied after a restart.' },
      { key: 'general.logLevel', label: 'Log level', kind: 'level', help: 'Debug logs every request; info is enough day to day.' },
    ],
  },
  {
    id: 'network',
    title: 'Network',
    description: 'Who can reach the server.',
    fields: [
      { key: 'network.lanSharing', label: 'Share on the local network', kind: 'switch', help: 'Listen on every interface (devices pair first). Off: this machine only. Applied after a restart.' },
      { key: 'network.discovery', label: 'Let devices find this server', kind: 'switch', help: 'Announce it on the network (mDNS and UDP port 28471), so apps list it without typing an address. Needs sharing on the local network.' },
      { key: 'network.allowedHosts', label: 'Extra host names', kind: 'list', placeholder: 'media.home.lan', help: 'DNS names that point at this machine (IP addresses, localhost and this machine’s name always work).' },
      { key: 'network.corsOrigins', label: 'Extra web origins', kind: 'list', placeholder: 'http://192.168.1.20:8080', help: 'Web apps on other origins allowed to call the API.' },
    ],
  },
  {
    id: 'dlna',
    title: 'DLNA',
    description: 'TVs, consoles and players on the network (Samsung, LG, VLC, Kodi, Windows) browse and play the library without Playpex TV. DLNA has no pairing: it only serves the folders you include, never adults-only ones, and changes nothing.',
    fields: [
      { key: 'dlna.enabled', label: 'DLNA media server', kind: 'switch', help: 'Announces this server on the network (SSDP, UDP port 1900). Needs sharing on the local network. Applied when you save.' },
      { key: 'dlna.port', label: 'DLNA port', kind: 'number', min: 1024, help: 'Its own HTTP port (default 28472), separate from the API: it only serves the included folders. Applied when you save.' },
    ],
  },
  {
    id: 'security',
    title: 'Security',
    description: 'Pairing of devices.',
    fields: [
      { key: 'security.requirePairingOnLoopback', label: 'Pair clients on this machine too', kind: 'switch', help: 'Off: apps on the server machine are trusted without pairing.' },
      { key: 'security.pairingRequestMinutes', label: 'Pairing code lifetime (minutes)', kind: 'number', help: 'How long a code shown by a client can be approved. Applied after a restart.' },
    ],
  },
  {
    id: 'storage',
    title: 'Storage',
    description: 'Where torrents are downloaded.',
    fields: [
      { key: 'storage.downloadDir', label: 'Download directory', kind: 'dir', help: 'Empty = the default. Applied after a restart; what is in the old directory stays there.' },
    ],
  },
  {
    id: 'streaming',
    title: 'Streaming',
    description: 'Limits that keep the server responsive.',
    fields: [
      { key: 'streaming.maxTorrents', label: 'Torrents at once', kind: 'number', help: 'Running torrents, streams and downloads together. A new stream past it pauses a download nobody watches, else it is refused (clients show “server busy”).' },
      { key: 'streaming.maxTranscodes', label: 'Audio transcodes at once', kind: 'number', help: 'Each one runs ffmpeg.' },
      { key: 'streaming.idleTimeoutMinutes', label: 'Idle timeout (minutes)', kind: 'number', help: 'A device silent this long (crashed, offline) loses its torrents.' },
    ],
  },
  {
    id: 'downloads',
    title: 'Downloads',
    description: 'Torrents are kept: leaving the player pauses them, nothing is deleted unless you remove it.',
    fields: [
      { key: 'downloads.engine', label: 'Torrent engine', kind: 'engine', help: 'Applied after a restart; downloads, their files and progress carry over. If it can’t start, torrent-stream runs instead.' },
      { key: 'downloads.maxActive', label: 'Downloads at once', kind: 'number', help: 'Torrents downloading without a player. The others wait in the queue.' },
      { key: 'downloads.seedRatio', label: 'Seed up to ratio', kind: 'number', min: 0, step: 0.1, help: 'A finished download keeps uploading until it sent this many times its size. 0 = no ratio limit.' },
      { key: 'downloads.seedMinutes', label: 'Seed for (minutes)', kind: 'number', min: 0, help: '…or this long, whichever comes first. 0 = no time limit; both 0 = no seeding.' },
      { key: 'downloads.uploadSlots', label: 'Upload slots per torrent', kind: 'number', min: 0, help: 'Peers uploaded to at once. 0 = never upload. Applies to torrents started from now on.' },
      { key: 'downloads.peerPort', label: 'Peer port', kind: 'number', min: 1024, help: 'Where other BitTorrent clients reach this server. Taken: another free port is used. Applied after a restart.' },
      { key: 'downloads.portForwarding', label: 'Forward the peer port (UPnP)', kind: 'switch', help: 'Ask the router to open the peer port: more peers, faster downloads. rqbit only. Applied after a restart.' },
      { key: 'downloads.paused', label: 'Pause all downloads', kind: 'switch', help: 'Downloads wait in the queue (streams still play). Kept across restarts; the tray icon toggles it too.' },
    ],
  },
  {
    id: 'providers',
    title: 'Providers',
    description: 'API keys of optional services. Stored on the server, never shown in full.',
    fields: [
      { key: 'providers.tmdbApiKey', label: 'TMDB', kind: 'secret', help: 'Recommendations and the 18+ catalog. themoviedb.org/settings/api' },
      { key: 'providers.openSubtitlesApiKey', label: 'OpenSubtitles.com', kind: 'secret', help: 'opensubtitles.com/en/consumers' },
      { key: 'providers.wyzieApiKey', label: 'Wyzie Subs', kind: 'secret', help: 'store.wyzie.io/redeem' },
      { key: 'providers.thePornDbApiKey', label: 'ThePornDB', kind: 'secret', help: 'Metadata of the 18+ section.' },
    ],
  },
  {
    id: 'transcoding',
    title: 'Transcoding',
    description: 'ffmpeg converts Dolby / DTS audio that browsers can’t play.',
    fields: [
      { key: 'transcoding.ffmpegPath', label: 'ffmpeg path', kind: 'text', placeholder: 'bundled copy, else the PATH' },
      { key: 'transcoding.ffprobePath', label: 'ffprobe path', kind: 'text', placeholder: 'bundled copy, else the PATH' },
    ],
  },
]

type Values = Record<string, unknown>

function flatten(obj: Record<string, unknown>, prefix = ''): Values {
  return Object.entries(obj).reduce<Values>((all, [k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k
    return v && typeof v === 'object' && !Array.isArray(v) ? { ...all, ...flatten(v as Record<string, unknown>, key) } : { ...all, [key]: v }
  }, {})
}

function nest(values: Values) {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [key, value] of Object.entries(values)) {
    const [group, name] = key.split('.')
    ;(out[group] ??= {})[name] = value
  }
  return out
}

function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function PortField({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled: boolean }) {
  const check = useMutation({ mutationFn: (port: number) => unwrap(api.POST('/admin/settings/check-port', { body: { port } })) })
  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <Input
          type="number"
          min={1024}
          max={65535}
          className="w-32 font-mono"
          value={Number.isFinite(value) ? value : ''}
          disabled={disabled}
          onChange={(e) => {
            onChange(e.target.valueAsNumber)
            check.reset()
          }}
        />
        <Button type="button" variant="outline" disabled={disabled || !Number.isFinite(value)} onClick={() => check.mutate(value)}>
          Check
        </Button>
      </div>
      {check.data && (
        <p className={`text-xs ${check.data.free ? 'text-success' : 'text-destructive'}`}>
          {check.data.current
            ? 'The port the server uses now.'
            : check.data.free
              ? 'Free: the server can use it.'
              : `In use${check.data.owner ? ` by ${check.data.owner.name ?? 'a process'} (pid ${check.data.owner.pid})` : ''}.`}
        </p>
      )}
      {check.error && <p className="text-xs text-destructive">{errorMessage(check.error)}</p>}
    </div>
  )
}

function DirField({ value, onChange, disabled, fallback }: { value: string; onChange: (v: string) => void; disabled: boolean; fallback: string }) {
  const check = useMutation({ mutationFn: (dir: string) => unwrap(api.POST('/admin/storage/check', { body: { dir } })) })
  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <Input
          className="font-mono text-xs"
          value={value}
          placeholder={fallback}
          disabled={disabled}
          onChange={(e) => {
            onChange(e.target.value)
            check.reset()
          }}
        />
        <Button type="button" variant="outline" disabled={disabled} onClick={() => check.mutate(value || fallback)}>
          Check
        </Button>
      </div>
      {check.data && (
        <p className={`text-xs ${check.data.writable ? 'text-success' : 'text-destructive'}`}>
          {check.data.writable
            ? `${check.data.exists ? 'Writable' : 'Will be created'} · ${bytes(check.data.free)} free of ${bytes(check.data.total)}`
            : 'The server can’t write there.'}
        </p>
      )}
      {check.error && <p className="text-xs text-destructive">{errorMessage(check.error)}</p>}
    </div>
  )
}

// The torrent engine: a choice among the installed ones, with what each is
// good at; optional engines (sidecar programs) are installed / removed here,
// never bundled with the server
function EngineField({
  value,
  onChange,
  disabled,
  view,
}: {
  value: string
  onChange: (v: unknown) => void
  disabled: boolean
  view: SettingsView
}) {
  const client = useQueryClient()
  const change = useMutation({
    mutationFn: ({ id, remove }: { id: string; remove: boolean }) =>
      remove
        ? unwrap(api.DELETE('/admin/engines/{id}', { params: { path: { id } } }))
        : unwrap(api.POST('/admin/engines/{id}/install', { params: { path: { id } } })),
    onSuccess: (_, { id, remove }) => {
      toast.success(remove ? `${id} removed` : `${id} installed`)
      client.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const chosen = view.engines.find((e) => e.id === value)
  return (
    <div className="space-y-3">
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {view.engines.map((e) => (
            <SelectItem key={e.id} value={e.id} disabled={!e.available && e.id !== value}>
              {e.name}
              {!e.available && ' (not installed)'}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {chosen && !chosen.available && <p className="text-xs text-destructive">{chosen.detail}</p>}
      {view.engine && view.engine !== value && (
        <p className="text-xs text-muted-foreground">
          Running now: <span className="font-mono">{view.engine}</span>
        </p>
      )}
      <div className="divide-y rounded-md border">
        {view.engines.map((e) => (
          <div key={e.id} className="flex items-start justify-between gap-4 p-3">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {e.name}
                {e.installed === 'builtin' ? (
                  <Badge variant="secondary">built in</Badge>
                ) : e.installed ? (
                  <Badge variant="secondary">{e.version ? `v${e.version}` : e.installed}</Badge>
                ) : (
                  <Badge variant="outline">not installed</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{e.summary}</p>
            </div>
            {e.installed !== 'builtin' && e.installed !== 'env' && e.installed !== 'path' && (
              <div className="shrink-0">
                {e.installed ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={change.isPending || view.engine === e.id}
                    onClick={() => change.mutate({ id: e.id, remove: true })}
                  >
                    Remove
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    disabled={change.isPending || !e.installable}
                    title={e.installable ? `Download ${e.name} ${e.latest ?? ''}` : 'No build for this platform'}
                    onClick={() => change.mutate({ id: e.id, remove: false })}
                  >
                    {change.isPending && change.variables?.id === e.id ? <Spinner /> : null}
                    Install
                  </Button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function FieldRow({
  field,
  view,
  value,
  onChange,
  fallbackDir,
}: {
  field: Field
  view: SettingsView
  value: unknown
  onChange: (v: unknown) => void
  fallbackDir: string
}) {
  const envVar = view.env[field.key]
  const locked = view.sources[field.key] === 'env'
  const id = field.key.replace('.', '-')
  let control: ReactNode
  switch (field.kind) {
    case 'switch':
      control = <Switch id={id} checked={!!value} disabled={locked} onCheckedChange={onChange} />
      break
    case 'number':
      control = (
        <Input id={id} type="number" min={field.min ?? 1} step={field.step ?? 1} className="w-32 font-mono" value={Number.isFinite(value) ? (value as number) : ''} disabled={locked} onChange={(e) => onChange(e.target.valueAsNumber)} />
      )
      break
    case 'port':
      control = <PortField value={value as number} onChange={onChange} disabled={locked} />
      break
    case 'dir':
      control = <DirField value={value as string} onChange={onChange} disabled={locked} fallback={fallbackDir} />
      break
    case 'engine':
      control = <EngineField value={value as string} onChange={onChange} disabled={locked} view={view} />
      break
    case 'level':
      control = (
        <Select value={value as string} onValueChange={onChange} disabled={locked}>
          <SelectTrigger id={id} className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {view.logLevels.map((l) => (
              <SelectItem key={l} value={l}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
      break
    case 'list':
      control = (
        <Input
          id={id}
          className="font-mono text-xs"
          placeholder={field.placeholder}
          value={(value as string[]).join(', ')}
          disabled={locked}
          onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trimStart()))}
        />
      )
      break
    case 'secret': {
      const stored = (flatten(view.settings as unknown as Record<string, unknown>)[field.key] as string) || ''
      control = (
        <div className="flex gap-2">
          <Input
            id={id}
            type="password"
            autoComplete="off"
            className="font-mono text-xs"
            placeholder={stored ? (value === '' ? 'removed when you save' : `${stored} (unchanged)`) : 'not set'}
            value={value === stored ? '' : (value as string)}
            disabled={locked}
            onChange={(e) => onChange(e.target.value || stored)}
          />
          {stored && !locked && (
            <Button type="button" variant="outline" onClick={() => onChange('')}>
              Remove
            </Button>
          )}
        </div>
      )
      break
    }
    default:
      control = (
        <Input id={id} placeholder={field.placeholder} className={field.key.includes('Path') ? 'font-mono text-xs' : undefined} value={value as string} disabled={locked} onChange={(e) => onChange(e.target.value)} />
      )
  }
  const inline = field.kind === 'switch'
  return (
    <div className={inline ? 'flex items-start justify-between gap-6' : 'grid gap-2 md:grid-cols-[14rem_1fr] md:gap-6'}>
      <div className="space-y-1">
        <Label htmlFor={id} className="flex flex-wrap items-center gap-2">
          {field.label}
          {locked && (
            <Badge variant="outline" title="Environment variables win over settings.json">
              <Lock /> {envVar}
            </Badge>
          )}
        </Label>
        {field.help && inline && <p className="text-xs text-muted-foreground">{field.help}</p>}
      </div>
      <div className="min-w-0 space-y-1.5">
        {control}
        {field.help && !inline && <p className="text-xs text-muted-foreground">{field.help}</p>}
      </div>
    </div>
  )
}

function PasswordCard() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const navigate = useNavigate()
  const client = useQueryClient()
  const change = useMutation({
    mutationFn: () => unwrap(api.PUT('/admin/password', { body: { currentPassword: current, newPassword: next } })),
    onSuccess: () => {
      toast.success('Password changed: sign in again')
      client.setQueryData(['session'], null)
      navigate('/login')
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    change.mutate()
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Admin password</CardTitle>
        <CardDescription>Signs out every dashboard session; paired devices stay paired.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid max-w-md gap-3">
          {change.error && <p className="text-sm text-destructive">{errorMessage(change.error)}</p>}
          <Input type="password" autoComplete="current-password" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          <Input type="password" autoComplete="new-password" placeholder="New password (8+ characters)" minLength={8} maxLength={128} value={next} onChange={(e) => setNext(e.target.value)} required />
          <Button type="submit" className="w-fit" disabled={change.isPending}>
            {change.isPending && <Spinner />} Change password
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

function RestartBanner({ reasons }: { reasons: string[] }) {
  const [movedTo, setMovedTo] = useState<string | null>(null)
  const client = useQueryClient()
  const restart = useMutation({
    mutationFn: restartServer,
    onSuccess: (r) => {
      if (r.movedTo) setMovedTo(r.movedTo)
      else {
        toast.success('Server restarted')
        client.invalidateQueries()
      }
    },
  })
  if (movedTo) {
    return (
      <Alert>
        <Check />
        <AlertTitle>The server now listens on another port</AlertTitle>
        <AlertDescription>
          <a className="font-mono underline underline-offset-2" href={movedTo}>
            {movedTo}
          </a>
          <p>Sign in there again (sessions are per address). Paired clients reconnect by themselves once discovery exists; until then, re-enter the address.</p>
        </AlertDescription>
      </Alert>
    )
  }
  return (
    <Alert>
      <RotateCw />
      <AlertTitle>Restart to apply</AlertTitle>
      <AlertDescription>
        <p>{reasons.join(', ')} change{reasons.length === 1 ? 's' : ''} when the server restarts. Playing streams are interrupted.</p>
        {restart.error && <p className="text-destructive">{errorMessage(restart.error)}</p>}
        <Button size="sm" className="mt-2" disabled={restart.isPending} onClick={() => restart.mutate()}>
          {restart.isPending ? <Spinner /> : <RotateCw />} {restart.isPending ? 'Restarting…' : 'Restart server'}
        </Button>
      </AlertDescription>
    </Alert>
  )
}

const LABELS = Object.fromEntries(GROUPS.flatMap((g) => g.fields.map((f) => [f.key, f.label])))

export function SettingsPage() {
  const { tab = 'general' } = useParams()
  const navigate = useNavigate()
  const client = useQueryClient()
  const overview = useOverview()
  const host = useHost()
  const query = useQuery({ queryKey: ['settings'], queryFn: () => unwrap(api.GET('/admin/settings')) })
  const saved = useMemo(() => (query.data ? flatten(query.data.settings as unknown as Record<string, unknown>) : {}), [query.data])
  // Edits apply to the saved values they were made on; a new answer (saved, or
  // changed elsewhere) starts from the server's values again
  const [edit, setEdit] = useState<{ base: Values; values: Values } | null>(null)
  const draft = edit && edit.base === saved ? edit.values : saved
  const setDraft = (update: Values | ((d: Values) => Values)) =>
    setEdit({ base: saved, values: typeof update === 'function' ? update(draft) : update })
  const [pendingRestart, setPendingRestart] = useState<string[]>([])

  const changed = Object.keys(draft).filter((k) => !same(draft[k], saved[k]))
  const save = useMutation({
    mutationFn: () => {
      const patch: Values = {}
      for (const k of changed) {
        const v = draft[k]
        patch[k] = Array.isArray(v) ? v.map((s: string) => s.trim()).filter(Boolean) : v
      }
      return unwrap(api.PUT('/admin/settings', { body: nest(patch) }))
    },
    onSuccess: (r) => {
      client.setQueryData(['settings'], r.settings)
      client.invalidateQueries({ queryKey: ['overview'] })
      if (r.changed.some((k) => k.startsWith('dlna.') || k === 'general.serverName')) client.invalidateQueries({ queryKey: ['dlna'] })
      if (r.restartRequired.length) setPendingRestart((p) => [...new Set([...p, ...r.restartRequired])])
      if (r.lockedByEnv.length) toast.warning(`Saved, but environment variables still win for ${r.lockedByEnv.join(', ')}`)
      else toast.success('Settings saved')
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  if (query.isPending) return <Loading rows={5} />
  if (query.error) return <QueryError error={query.error} />
  const view = query.data
  const group = GROUPS.find((g) => g.id === tab)
  const server = overview.data?.server
  // A restart is also needed when the running port differs from the saved one (saved earlier, or recovery mode)
  const portPending = server && !server.recovery && server.port !== null && saved['general.port'] !== server.port && !import.meta.env.DEV
  const reasons = [...new Set([...pendingRestart, ...(portPending || server?.recovery ? ['general.port'] : [])])].map((k) => LABELS[k] ?? k)
  const fallbackDir = overview.data?.disks.find((d) => d.id === 'downloads')?.path ?? ''

  return (
    <>
      <PageHeader title="Settings" description={<span className="font-mono text-xs">{view.file}</span>} />
      {server?.recovery && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Port {server.recovery.port} is in use</AlertTitle>
          <AlertDescription>Choose a free port below (Check tells), save, then restart the server.</AlertDescription>
        </Alert>
      )}
      {reasons.length > 0 && <RestartBanner reasons={reasons} />}
      <Tabs value={tab} onValueChange={(v) => navigate(`/settings/${v}`)}>
        <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
          <TabsList>
            {GROUPS.map((g) => (
              <TabsTrigger key={g.id} value={g.id}>
                {g.title}
              </TabsTrigger>
            ))}
            {host.data?.kind === 'desktop' && <TabsTrigger value="desktop">Desktop app</TabsTrigger>}
            <TabsTrigger value="account">Account</TabsTrigger>
          </TabsList>
        </div>
      </Tabs>
      {tab === 'account' ? (
        <PasswordCard />
      ) : tab === 'desktop' ? (
        <DesktopCard streams={overview.data?.activity.sessions ?? 0} />
      ) : group ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
        >
          <Card>
            <CardHeader>
              <CardTitle>{group.title}</CardTitle>
              <CardDescription>{group.description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {group.fields.map((f) => (
                <FieldRow key={f.key} field={f} view={view} value={draft[f.key]} fallbackDir={fallbackDir} onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))} />
              ))}
            </CardContent>
          </Card>
          <div className="sticky bottom-0 mt-4 flex flex-wrap items-center justify-end gap-2 border-t bg-background/90 py-3 backdrop-blur">
            <span className="mr-auto text-sm text-muted-foreground">
              {changed.length ? `${changed.length} unsaved change${changed.length > 1 ? 's' : ''} (all tabs)` : 'No changes'}
            </span>
            <Button type="button" variant="outline" disabled={!changed.length} onClick={() => setDraft(saved)}>
              <Undo2 /> Discard
            </Button>
            <Button type="submit" disabled={!changed.length || save.isPending}>
              {save.isPending ? <Spinner /> : <Save />} Save
            </Button>
          </div>
          {group.id === 'dlna' && <DlnaPanel />}
        </form>
      ) : (
        <QueryError error={new Error(`No settings group "${tab}"`)} />
      )}
    </>
  )
}
