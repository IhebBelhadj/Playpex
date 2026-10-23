import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  BadgeCheck,
  Download,
  Link as LinkIcon,
  MoreHorizontal,
  Plus,
  Puzzle,
  RotateCw,
  ShieldAlert,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Confirm, Empty, Loading, Mono, PageHeader, QueryError, Spinner } from '@/components/common'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { API_PREFIX, api, errorMessage, unwrap, type Schemas } from '@/lib/api'
import { ago, bytes } from '@/lib/format'

// Plugins (docs/plugins-plan.md §6.3): what is installed, installing a package
// (an upload, or a URL: a direct link or a GitHub repository / release), and
// the trust settings (developer mode, trusted publisher keys). Installing is
// two steps: the server reads the package and shows what it is and what it
// may do, then the admin installs it. Clients never set plugins up.

type AdminPlugin = Schemas['AdminPlugin']
type Preview = Schemas['PluginPackagePreview']

const ORIGIN: Record<AdminPlugin['origin'], string> = { upload: 'Uploaded', url: 'From a URL', dev: 'Developer copy' }

function usePlugins() {
  return useQuery({ queryKey: ['admin-plugins'], queryFn: () => unwrap(api.GET('/admin/plugins')) })
}

function useRefresh() {
  const client = useQueryClient()
  return () => {
    client.invalidateQueries({ queryKey: ['admin-plugins'] })
    client.invalidateQueries({ queryKey: ['library'] }) // its information providers
  }
}

export function PluginsPage() {
  const plugins = usePlugins()
  const [installing, setInstalling] = useState(false)
  if (plugins.isPending) return <Loading />
  if (plugins.error) return <QueryError error={plugins.error} />
  const view = plugins.data

  return (
    <>
      <PageHeader
        title="Plugins"
        description="What plugins this server runs. Clients only show what they add: everything is set up here."
        actions={
          <Button onClick={() => setInstalling(true)}>
            <Plus /> Install plugin
          </Button>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Puzzle className="size-4" /> Installed
          </CardTitle>
          <CardDescription>
            Installed in <Mono className="text-xs">{view.pluginsDir}</Mono>
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {view.plugins.length === 0 ? (
            <Empty icon={<Puzzle />} title="No plugins yet">
              Install one from a package file (.ppx or .zip) or a link, such as a GitHub release.
            </Empty>
          ) : (
            <div className="divide-y">
              {view.plugins.map((p) => (
                <PluginRow key={p.id} plugin={p} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <TrustCard developerMode={view.developerMode} keys={view.publisherKeys} devDir={view.devDir} />
      <InstallDialog open={installing} onOpenChange={setInstalling} developerMode={view.developerMode} />
    </>
  )
}

// ── installed ─────────────────────────────────────────────────────────────────

function stateBadge(p: AdminPlugin) {
  switch (p.state) {
    case 'enabled':
      return <Badge variant="secondary">Running</Badge>
    case 'disabled':
      return <Badge variant="outline">Off</Badge>
    case 'loading':
      return <Badge variant="outline">Starting…</Badge>
    default:
      return <Badge variant="destructive">Stopped</Badge>
  }
}

function PluginIcon({ src, className }: { src?: string | null; className?: string }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) {
    return (
      <div className={`flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground ${className ?? ''}`}>
        <Puzzle className="size-5" />
      </div>
    )
  }
  return <img src={src} alt="" className={`size-10 shrink-0 rounded-lg bg-muted object-contain p-1 ${className ?? ''}`} onError={() => setFailed(true)} />
}

function PluginRow({ plugin: p }: { plugin: AdminPlugin }) {
  const refresh = useRefresh()
  const enable = useMutation({
    mutationFn: (enabled: boolean) => unwrap(api.PATCH('/admin/plugins/{pluginId}', { params: { path: { pluginId: p.id } }, body: { enabled } })),
    onSuccess: (r) => {
      toast.success(r.enabled ? (r.state === 'enabled' ? `${r.name} is on` : `${r.name} didn't start`) : `${r.name} is off`)
      refresh()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const reload = useMutation({
    mutationFn: () => unwrap(api.POST('/admin/plugins/{pluginId}/reload', { params: { path: { pluginId: p.id } } })),
    onSuccess: (r) => {
      toast.success(r.state === 'enabled' ? `${r.name} reloaded` : `${r.name} didn't start: ${r.error}`)
      refresh()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const remove = useMutation({
    mutationFn: (keep: boolean) =>
      unwrap(api.DELETE('/admin/plugins/{pluginId}', { params: { path: { pluginId: p.id }, query: { data: keep ? 'keep' : 'delete' } } })),
    onSuccess: () => {
      toast.success(`${p.name} removed`)
      refresh()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const [details, setDetails] = useState(false)
  const dev = p.origin === 'dev'

  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <PluginIcon src={p.icon ? API_PREFIX + p.icon : null} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{p.name}</span>
          <span className="font-mono text-xs text-muted-foreground">{p.version}</span>
          {stateBadge(p)}
          <Badge variant="outline">{ORIGIN[p.origin]}</Badge>
          {!dev &&
            (p.signer ? (
              <Badge variant="outline" title={`Publisher key ${p.signer}`}>
                <BadgeCheck /> Signed
              </Badge>
            ) : (
              <Badge variant="outline">Unsigned</Badge>
            ))}
          {p.audience === 'adults' && <Badge variant="outline">Adults only</Badge>}
        </div>
        {p.description && <p className="text-sm text-muted-foreground">{p.description}</p>}
        {p.error && p.state !== 'disabled' && (
          <p className="flex items-start gap-1.5 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {p.error}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {p.publisher?.name && `By ${p.publisher.name} · `}
          {p.source && (
            <span className="break-all" title={p.source}>
              {p.source}
            </span>
          )}
          {p.updatedAt && ` · ${p.installedAt === p.updatedAt ? 'installed' : 'updated'} ${ago(p.updatedAt)}`}
        </p>
        {details && (
          <ul className="mt-2 space-y-1 text-sm">
            {p.permissions.length === 0 && <li className="text-muted-foreground">Asks for nothing</li>}
            {p.permissions.map((perm) => (
              <li key={perm.key} className="flex gap-2">
                <span className="text-muted-foreground">•</span> {perm.text}
              </li>
            ))}
          </ul>
        )}
        <button type="button" className="text-xs text-muted-foreground underline underline-offset-2" onClick={() => setDetails(!details)}>
          {details ? 'Hide what it may do' : `What it may do (${p.permissions.length})`}
        </button>
      </div>
      <div className="flex items-center gap-2">
        {!dev && (
          <Switch
            checked={p.enabled}
            disabled={enable.isPending}
            onCheckedChange={(on) => enable.mutate(on)}
            aria-label={p.enabled ? `Turn ${p.name} off` : `Turn ${p.name} on`}
          />
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="More">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {dev ? (
              <DropdownMenuItem disabled={reload.isPending} onSelect={() => reload.mutate()}>
                <RotateCw /> Reload from its folder
              </DropdownMenuItem>
            ) : (
              <>
                <Confirm
                  title={`Remove ${p.name}?`}
                  description="Its files go, and everything it kept: its storage, the secrets and settings entered for it. Library folders it recognised go back to Playpex's own matching."
                  action="Remove"
                  onConfirm={() => remove.mutate(false)}
                  trigger={
                    <DropdownMenuItem variant="destructive" onSelect={(e) => e.preventDefault()}>
                      <Trash2 /> Remove
                    </DropdownMenuItem>
                  }
                />
                <DropdownMenuSeparator />
                <Confirm
                  title={`Remove ${p.name}, keep its data?`}
                  description="Its files go; its storage, secrets and settings stay, for when you install it again."
                  action="Remove"
                  onConfirm={() => remove.mutate(true)}
                  trigger={<DropdownMenuItem onSelect={(e) => e.preventDefault()}>Remove, keep its data</DropdownMenuItem>}
                />
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

// ── installing ────────────────────────────────────────────────────────────────

function InstallDialog({ open, onOpenChange, developerMode }: { open: boolean; onOpenChange: (open: boolean) => void; developerMode: boolean }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        {open && <InstallFlow developerMode={developerMode} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function InstallFlow({ developerMode, onDone }: { developerMode: boolean; onDone: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null)
  return preview ? (
    <PreviewStep preview={preview} developerMode={developerMode} onBack={() => setPreview(null)} onDone={onDone} onChange={setPreview} />
  ) : (
    <SourceStep onRead={setPreview} />
  )
}

function SourceStep({ onRead }: { onRead: (p: Preview) => void }) {
  const [mode, setMode] = useState<'file' | 'url'>('file')
  const [file, setFile] = useState<File | null>(null)
  const [url, setUrl] = useState('')
  const read = useMutation({
    mutationFn: () => {
      if (mode === 'file' && file) {
        const form = new FormData()
        form.append('file', file)
        return unwrap(api.POST('/admin/plugins/packages', { body: form as never, bodySerializer: (b: unknown) => b as FormData }))
      }
      return unwrap(api.POST('/admin/plugins/packages', { body: { url: url.trim() } }))
    },
    onSuccess: onRead,
    onError: (err) => toast.error(errorMessage(err)),
  })
  const ready = mode === 'file' ? !!file : /^https?:\/\/\S+$/.test(url.trim())
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (ready) read.mutate()
  }

  return (
    <form onSubmit={submit} className="contents">
      <DialogHeader>
        <DialogTitle>Install a plugin</DialogTitle>
        <DialogDescription>A package (.ppx or .zip), or a link to one. You see what it is and what it may do before it's installed.</DialogDescription>
      </DialogHeader>
      <Tabs value={mode} onValueChange={(v) => setMode(v as 'file' | 'url')}>
        <TabsList>
          <TabsTrigger value="file">
            <Upload /> Upload a file
          </TabsTrigger>
          <TabsTrigger value="url">
            <LinkIcon /> From a link
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {mode === 'file' ? (
        <div className="space-y-2">
          <Label htmlFor="plugin-file">Package</Label>
          <Input id="plugin-file" type="file" accept=".ppx,.zip,application/zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <p className="text-xs text-muted-foreground">At most 20 MB.</p>
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="plugin-url">Link</Label>
          <Input
            id="plugin-url"
            placeholder="https://github.com/owner/repo"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            A link to a .ppx or .zip, or a GitHub repository or release page: its latest (or that) release's package, else its source.
          </p>
        </div>
      )}
      <DialogFooter>
        <Button type="submit" disabled={!ready || read.isPending}>
          {read.isPending ? <Spinner /> : <Download />} {mode === 'url' ? 'Download and check' : 'Check package'}
        </Button>
      </DialogFooter>
    </form>
  )
}

const CHANGE: Record<Preview['change'], string> = {
  install: 'Install',
  update: 'Update',
  downgrade: 'Install older version',
  reinstall: 'Reinstall',
}

function PreviewStep({
  preview: p,
  developerMode,
  onBack,
  onDone,
  onChange,
}: {
  preview: Preview
  developerMode: boolean
  onBack: () => void
  onDone: () => void
  onChange: (p: Preview) => void
}) {
  const refresh = useRefresh()
  const client = useQueryClient()
  const install = useMutation({
    mutationFn: () => unwrap(api.POST('/admin/plugins/packages/{token}/install', { params: { path: { token: p.token } } })),
    onSuccess: (r) => {
      toast.success(r.state === 'enabled' ? `${r.name} ${r.version} installed` : `${r.name} ${r.version} installed (off)`)
      refresh()
      onDone()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const discard = () => {
    api.DELETE('/admin/plugins/packages/{token}', { params: { path: { token: p.token } } }).catch(() => {})
    onBack()
  }
  const developer = useMutation({
    mutationFn: () => unwrap(api.PUT('/admin/settings', { body: { plugins: { developerMode: true } } })),
    onSuccess: () => {
      toast.success('Developer mode is on: unsigned plugins install')
      client.invalidateQueries({ queryKey: ['admin-plugins'] })
      client.invalidateQueries({ queryKey: ['settings'] })
      onChange({ ...p, installable: !p.conflict, reason: p.conflict ?? null })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const unsignedFix = !p.installable && !p.conflict && !developerMode

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-3">
          <PluginIcon src={p.icon} />
          <div className="min-w-0">
            <DialogTitle>
              {p.name} <span className="font-mono text-sm font-normal text-muted-foreground">{p.version}</span>
            </DialogTitle>
            <DialogDescription>
              {p.publisher?.name ? `By ${p.publisher.name}` : p.id}
              {p.current && ` · ${p.version === p.current ? 'installed already' : `installed: ${p.current}`}`}
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>
      <div className="max-h-[60vh] space-y-4 overflow-y-auto">
        {p.description && <p className="text-sm">{p.description}</p>}
        <div className="flex flex-wrap gap-2">
          {p.signer ? (
            p.signer.trusted ? (
              <Badge variant="secondary">
                <BadgeCheck /> Signed by a trusted publisher
              </Badge>
            ) : (
              <Badge variant="outline">Signed by an unknown key ({p.signer.fingerprint})</Badge>
            )
          ) : (
            <Badge variant="outline">Unsigned</Badge>
          )}
          {p.audience === 'adults' && <Badge variant="outline">Adults only: never for kids profiles</Badge>}
          <Badge variant="outline">
            {bytes(p.size)} · {p.fileCount} files
          </Badge>
        </div>
        <div className="space-y-1 text-xs text-muted-foreground">
          <div className="break-all">From {p.source}</div>
          {p.resolved && <div className="break-all">Downloaded: {p.resolved}</div>}
          {p.root && <div className="break-all">Found in the folder {p.root}</div>}
        </div>
        <div>
          <div className="mb-1.5 text-sm font-medium">What it may do</div>
          <ul className="space-y-1 text-sm">
            {p.permissions.length === 0 && <li className="text-muted-foreground">Asks for nothing</li>}
            {p.permissions.map((perm) => (
              <li key={perm.key} className="flex gap-2">
                <span className="text-muted-foreground">•</span> {perm.text}
              </li>
            ))}
          </ul>
        </div>
        {p.changelog && (
          <div>
            <div className="mb-1.5 text-sm font-medium">Changes</div>
            <pre className="max-h-40 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">{p.changelog}</pre>
          </div>
        )}
        {!p.installable && (
          <Alert variant={p.conflict ? 'destructive' : 'default'}>
            <ShieldAlert />
            <AlertTitle>{p.conflict ? "Can't install it now" : 'Not from a trusted publisher'}</AlertTitle>
            <AlertDescription>
              <p>{p.reason}</p>
              {unsignedFix && (
                <p>
                  Developer mode lets unsigned plugins install. Turn it on only for plugins whose author you trust: a plugin runs in a
                  sandbox, but it can still reach the sites it lists.
                </p>
              )}
            </AlertDescription>
          </Alert>
        )}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={discard}>
          <X /> Cancel
        </Button>
        {unsignedFix && (
          <Button variant="outline" disabled={developer.isPending} onClick={() => developer.mutate()}>
            {developer.isPending && <Spinner />} Turn on developer mode
          </Button>
        )}
        <Button disabled={!p.installable || install.isPending} onClick={() => install.mutate()}>
          {install.isPending && <Spinner />} {CHANGE[p.change]}
        </Button>
      </DialogFooter>
    </>
  )
}

// ── trust settings ────────────────────────────────────────────────────────────

function TrustCard({ developerMode, keys, devDir }: { developerMode: boolean; keys: { key: string; fingerprint: string }[]; devDir: string }) {
  const client = useQueryClient()
  const [key, setKey] = useState('')
  const save = useMutation({
    mutationFn: (patch: { developerMode?: boolean; publisherKeys?: string[] }) => unwrap(api.PUT('/admin/settings', { body: { plugins: patch } })),
    onSuccess: (_r, patch) => {
      if (patch.developerMode !== undefined) {
        toast.success(patch.developerMode ? 'Developer mode is on (developer folders load after a restart)' : 'Developer mode is off')
      } else {
        toast.success('Saved')
      }
      setKey('')
      client.invalidateQueries({ queryKey: ['admin-plugins'] })
      client.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const add = (e: FormEvent) => {
    e.preventDefault()
    if (key.trim()) save.mutate({ publisherKeys: [...keys.map((k) => k.key), key.trim()] })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Trust</CardTitle>
        <CardDescription>
          Packages signed by a trusted publisher always install. Unsigned ones (most GitHub releases) only in developer mode.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="developer-mode">Developer mode</Label>
            <p className="text-xs text-muted-foreground">
              Unsigned plugins install, and plugins in <Mono className="text-xs">{devDir}</Mono> run (after a restart).
            </p>
          </div>
          <Switch
            id="developer-mode"
            checked={developerMode}
            disabled={save.isPending}
            onCheckedChange={(on) => save.mutate({ developerMode: on })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="publisher-key">Trusted publisher keys</Label>
          {keys.length > 0 && (
            <ul className="divide-y rounded-md border">
              {keys.map((k) => (
                <li key={k.key} className="flex items-center gap-2 px-3 py-2">
                  <BadgeCheck className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 font-mono text-xs" title={k.key}>
                    {k.fingerprint}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Stop trusting this key"
                    disabled={save.isPending}
                    onClick={() => save.mutate({ publisherKeys: keys.filter((x) => x.key !== k.key).map((x) => x.key) })}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={add} className="flex gap-2">
            <Input id="publisher-key" placeholder="ed25519:…" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
            <Button type="submit" variant="outline" disabled={!key.trim() || save.isPending}>
              Trust
            </Button>
          </form>
          <p className="text-xs text-muted-foreground">
            A publisher's public key, as their release notes give it (they make it with <Mono className="text-xs">npm run pack:plugin -- --keygen</Mono>).
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
