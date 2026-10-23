import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, BadgeCheck, ChevronRight, Download, Link as LinkIcon, Plus, Puzzle, Trash2, Upload } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Empty, Loading, Mono, PageHeader, QueryError, Spinner } from '@/components/common'
import {
  ORIGIN,
  PackagePreview,
  PluginIcon,
  PluginStateBadge,
  useRefreshPlugins,
  type AdminPlugin,
  type Preview,
} from '@/components/plugin-common'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { API_PREFIX, api, errorMessage, unwrap } from '@/lib/api'
import { ago } from '@/lib/format'

// Plugins (docs/plugins-plan.md §6.3): what is installed (each opens its own
// page: pages/plugin.tsx), installing a package (an upload, or a URL: a
// direct link or a GitHub repository / release), and the trust settings
// (developer mode, trusted publisher keys). Installing is two steps: the
// server reads the package and shows what it is and what it may do, then the
// admin installs it. Clients never set plugins up.

export function usePlugins() {
  return useQuery({ queryKey: ['admin-plugins'], queryFn: () => unwrap(api.GET('/admin/plugins')) })
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

export function EnableSwitch({ plugin: p }: { plugin: AdminPlugin }) {
  const refresh = useRefreshPlugins()
  const enable = useMutation({
    mutationFn: (enabled: boolean) => unwrap(api.PATCH('/admin/plugins/{pluginId}', { params: { path: { pluginId: p.id } }, body: { enabled } })),
    onSuccess: (r) => {
      toast.success(r.enabled ? (r.state === 'enabled' ? `${r.name} is on` : `${r.name} didn't start`) : `${r.name} is off`)
      refresh()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  if (p.origin === 'dev') return null
  return (
    <Switch
      checked={p.enabled}
      disabled={enable.isPending}
      onCheckedChange={(on) => enable.mutate(on)}
      aria-label={p.enabled ? `Turn ${p.name} off` : `Turn ${p.name} on`}
    />
  )
}

function PluginRow({ plugin: p }: { plugin: AdminPlugin }) {
  const dev = p.origin === 'dev'
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <PluginIcon src={p.icon ? API_PREFIX + p.icon : null} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/plugins/${encodeURIComponent(p.id)}`} className="font-medium hover:underline">
            {p.name}
          </Link>
          <span className="font-mono text-xs text-muted-foreground">{p.version}</span>
          <PluginStateBadge plugin={p} />
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
          {p.permissions.length === 0 ? 'Asks for nothing' : `${p.permissions.length} permission${p.permissions.length > 1 ? 's' : ''}`}
          {p.updatedAt && ` · ${p.installedAt === p.updatedAt ? 'installed' : 'updated'} ${ago(p.updatedAt)}`}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <EnableSwitch plugin={p} />
        <Button variant="outline" size="sm" asChild>
          <Link to={`/plugins/${encodeURIComponent(p.id)}`}>
            Open <ChevronRight />
          </Link>
        </Button>
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
    <PackagePreview preview={preview} developerMode={developerMode} onBack={() => setPreview(null)} onDone={onDone} onChange={setPreview} />
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
