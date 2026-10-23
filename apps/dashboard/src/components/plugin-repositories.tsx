import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Download, KeyRound, Library, Plus, RefreshCw, Search, ShieldCheck, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Confirm, Empty, Loading, Mono, QueryError, Spinner } from '@/components/common'
import { PackagePreview, PluginIcon, useRefreshPlugins, type Preview } from '@/components/plugin-common'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { api, errorMessage, unwrap, type Schemas } from '@/lib/api'
import { ago } from '@/lib/format'

// The Plugins page's repository tabs (docs/plugins-plan.md §6.1–6.4):
// Browse (every plugin of the enabled repositories), Updates (from each
// plugin's origin repository, the server's policy, "Update all") and
// Repositories (trusted once by their key fingerprint; a new key waits for
// the admin; the official one is built in and never offers adults plugins).
// Installing anything goes through the same preview as an upload.

type CatalogPlugin = Schemas['PluginCatalog']['plugins'][number]
type Repository = Schemas['PluginRepository']
type RepositoryPreview = Schemas['PluginRepositoryPreview']

const CATEGORIES = ['catalog', 'sources', 'resolvers', 'subtitles', 'metadata', 'library', 'tracking', 'notifications', 'tools']
const POLICY: Record<'auto' | 'notify' | 'never', string> = {
  auto: 'Install them (unless they ask for more)',
  notify: 'Only list them here',
  never: "Don't look for them",
}

export function useRepositories() {
  return useQuery({ queryKey: ['plugin-repositories'], queryFn: () => unwrap(api.GET('/admin/plugins/repositories')) })
}

/** Stages a repository's plugin and shows its preview in a dialog */
function useStaging(developerMode: boolean) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const stage = useMutation({
    mutationFn: (v: { repository: string; id: string; version?: string }) => unwrap(api.POST('/admin/plugins/catalog/install', { body: v })),
    onSuccess: setPreview,
    onError: (err) => toast.error(errorMessage(err)),
  })
  const dialog = (
    <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
      <DialogContent className="sm:max-w-xl">
        {preview && (
          <PackagePreview
            preview={preview}
            developerMode={developerMode}
            onBack={() => setPreview(null)}
            onDone={() => setPreview(null)}
            onChange={setPreview}
          />
        )}
      </DialogContent>
    </Dialog>
  )
  return { stage, dialog }
}

// ── Browse ────────────────────────────────────────────────────────────────────

export function BrowseTab({ developerMode, onRepositories }: { developerMode: boolean; onRepositories: () => void }) {
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('all')
  const [open, setOpen] = useState<CatalogPlugin | null>(null)
  const catalog = useQuery({
    queryKey: ['plugin-catalog', q, category],
    queryFn: () =>
      unwrap(api.GET('/admin/plugins/catalog', { params: { query: { q: q || undefined, category: category === 'all' ? undefined : category } } })),
    placeholderData: (previous) => previous,
  })
  const repos = useRepositories()
  const { stage, dialog } = useStaging(developerMode)
  const none = repos.data && !repos.data.repositories.some((r) => r.enabled)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search plugins" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Every kind</SelectItem>
            {CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>
                {c[0].toUpperCase() + c.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {catalog.isPending ? (
        <Loading />
      ) : catalog.error ? (
        <QueryError error={catalog.error} title="Could not load the catalog" />
      ) : none ? (
        <Empty icon={<Library />} title="No repository">
          Plugins to browse come from repositories.{' '}
          <button type="button" className="underline underline-offset-2" onClick={onRepositories}>
            Add one
          </button>
          .
        </Empty>
      ) : catalog.data.plugins.length === 0 ? (
        <Empty icon={<Search />} title="Nothing found">
          {q || category !== 'all' ? 'No plugin matches.' : 'The repositories offer no plugin yet.'}
        </Empty>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {catalog.data.plugins.map((p) => (
            <button
              key={p.repository.id + '/' + p.id}
              type="button"
              onClick={() => setOpen(p)}
              className="flex items-start gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-muted/50"
            >
              <PluginIcon src={p.icon} />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{p.name}</span>
                  {p.latest && <span className="font-mono text-xs text-muted-foreground">{p.latest.version}</span>}
                  {p.update ? (
                    <Badge>Update</Badge>
                  ) : p.installed ? (
                    <Badge variant="secondary">Installed</Badge>
                  ) : null}
                  {p.latest?.audience === 'adults' && <Badge variant="outline">Adults only</Badge>}
                </div>
                {typeof p.listing?.summary === 'string' && <p className="line-clamp-2 text-sm text-muted-foreground">{p.listing.summary}</p>}
                <p className="text-xs text-muted-foreground">
                  {p.publisher?.name && `${p.publisher.name} · `}
                  {p.repository.name}
                  {p.incompatible && <span className="text-warning"> · {p.incompatible}</span>}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}
      <CatalogDialog plugin={open} onClose={() => setOpen(null)} onInstall={(v) => stage.mutate(v)} pending={stage.isPending} />
      {dialog}
    </div>
  )
}

function CatalogDialog({
  plugin: p,
  onClose,
  onInstall,
  pending,
}: {
  plugin: CatalogPlugin | null
  onClose: () => void
  onInstall: (v: { repository: string; id: string; version?: string }) => void
  pending: boolean
}) {
  const listing = (p?.listing ?? {}) as { summary?: string; description?: string; disclaimer?: string; license?: string; source?: string }
  const action = (version?: string) => {
    if (!p) return
    onInstall({ repository: p.repository.id, id: p.id, version })
    onClose()
  }
  return (
    <Dialog open={!!p} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        {p && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-3">
                <PluginIcon src={p.icon} />
                <div className="min-w-0">
                  <DialogTitle>{p.name}</DialogTitle>
                  <DialogDescription>
                    {p.publisher?.name ? `By ${p.publisher.name} · ` : ''}
                    {p.repository.name}
                    {p.installed && ` · installed: ${p.installed.version}`}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <div className="max-h-[60vh] space-y-4 overflow-y-auto">
              {(listing.description || listing.summary) && <p className="text-sm whitespace-pre-line">{listing.description || listing.summary}</p>}
              {listing.disclaimer && <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">{listing.disclaimer}</p>}
              {p.installed && p.installed.repository !== p.repository.id && (
                <Alert>
                  <AlertTriangle />
                  <AlertTitle>Installed from elsewhere</AlertTitle>
                  <AlertDescription>
                    Its updates come from where it was installed. Installing it from {p.repository.name} moves it here, and asks first.
                  </AlertDescription>
                </Alert>
              )}
              {p.latest && (
                <div>
                  <div className="mb-1.5 text-sm font-medium">What {p.latest.version} may do</div>
                  {p.latest.permissions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Asks for nothing</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {p.latest.permissions.map((perm) => (
                        <li key={perm.key + perm.text} className="flex gap-2">
                          <span className="text-muted-foreground">•</span> {perm.text}
                        </li>
                      ))}
                    </ul>
                  )}
                  {p.latest.requires.length > 0 && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Works with:{' '}
                      {p.latest.requires.map((r) => `${r.id} ${r.version}${r.optional ? ' (optional)' : ''}`).join(', ')}
                    </p>
                  )}
                </div>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {listing.license && <span>License: {listing.license}</span>}
                {listing.source && (
                  <a href={listing.source} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                    Source code
                  </a>
                )}
              </div>
              <div>
                <div className="mb-1.5 text-sm font-medium">Versions</div>
                <div className="divide-y rounded-md border">
                  {p.versions.map((v) => (
                    <div key={v.version} className="flex items-start gap-3 px-3 py-2 text-sm">
                      <div className="min-w-0 flex-1">
                        <span className="font-mono">{v.version}</span>{' '}
                        <span className="text-xs text-muted-foreground">{v.releasedAt}</span>{' '}
                        {v.lifecycle !== 'stable' && (
                          <Badge variant={v.lifecycle === 'broken' ? 'destructive' : 'outline'}>{v.lifecycle}</Badge>
                        )}
                        {!v.compatible && <Badge variant="outline">Needs a newer server</Badge>}
                        {v.version === p.installed?.version && p.installed?.repository === p.repository.id && (
                          <Badge variant="secondary">Installed</Badge>
                        )}
                        {(v.changelog || v.reason) && <p className="mt-0.5 text-xs whitespace-pre-line text-muted-foreground">{v.reason || v.changelog}</p>}
                      </div>
                      {v.compatible && v.version !== p.latest?.version && v.version !== p.installed?.version && (
                        <Button variant="ghost" size="sm" disabled={pending} onClick={() => action(v.version)}>
                          Install this one
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              <Button
                disabled={!p.latest || pending || (!p.update && p.installed?.version === p.latest.version && p.installed.repository === p.repository.id)}
                onClick={() => action()}
              >
                {pending ? <Spinner /> : <Download />} {p.update ? `Update to ${p.latest?.version}` : p.installed ? 'Installed' : 'Install'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ── Updates ───────────────────────────────────────────────────────────────────

export function UpdatesTab({ developerMode }: { developerMode: boolean }) {
  const client = useQueryClient()
  const refresh = useRefreshPlugins()
  const updates = useQuery({ queryKey: ['plugin-updates'], queryFn: () => unwrap(api.GET('/admin/plugins/updates')) })
  const { stage, dialog } = useStaging(developerMode)
  const check = useMutation({
    mutationFn: () => unwrap(api.POST('/admin/plugins/repositories/refresh', { body: {} })),
    onSuccess: () => {
      toast.success('Repositories checked')
      refresh()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const all = useMutation({
    mutationFn: () => unwrap(api.POST('/admin/plugins/updates/apply')),
    onSuccess: (r) => {
      const done = r.results.filter((x) => x.installed).length, left = r.results.length - done
      toast.success(`${done} updated${left ? `, ${left} waiting for you` : ''}`)
      refresh()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const policy = useMutation({
    mutationFn: (updates: 'auto' | 'notify' | 'never') => unwrap(api.PUT('/admin/settings', { body: { plugins: { updates } } })),
    onSuccess: () => {
      toast.success('Saved')
      client.invalidateQueries({ queryKey: ['plugin-updates'] })
      client.invalidateQueries({ queryKey: ['plugin-repositories'] })
      client.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  if (updates.isPending) return <Loading />
  if (updates.error) return <QueryError error={updates.error} title="Could not load the updates" />
  const list = updates.data.updates
  const plain = list.filter((u) => u.added.length === 0).length

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 pt-6">
          <div className="space-y-1">
            <Label>When a plugin has an update</Label>
            <p className="text-xs text-muted-foreground">
              An update asking for more than the installed version always waits for you. A plugin can have its own rule (its page, Versions).
            </p>
          </div>
          <Select value={updates.data.policy} onValueChange={(v) => policy.mutate(v as 'auto' | 'notify' | 'never')}>
            <SelectTrigger className="w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(POLICY) as (keyof typeof POLICY)[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {POLICY[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {list.length === 0 ? 'Everything is up to date.' : `${list.length} update${list.length > 1 ? 's' : ''}`}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={check.isPending} onClick={() => check.mutate()}>
            {check.isPending ? <Spinner /> : <RefreshCw />} Check now
          </Button>
          {plain > 0 && (
            <Button size="sm" disabled={all.isPending} onClick={() => all.mutate()}>
              {all.isPending && <Spinner />} Update all ({plain})
            </Button>
          )}
        </div>
      </div>
      {list.length > 0 && (
        <div className="divide-y rounded-lg border bg-card">
          {list.map((u) => (
            <div key={u.id} className="flex items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{u.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {u.installed} → {u.version}
                  </span>
                  {u.fixes && <Badge variant="destructive">Fixes a broken version</Badge>}
                  {u.added.length > 0 && <Badge variant="outline">Asks for more</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">
                  From {u.repository.name ?? u.repository.id} · {POLICY[u.policy].toLowerCase()}
                </p>
                {u.added.length > 0 && (
                  <ul className="text-sm">
                    {u.added.map((a) => (
                      <li key={a.key + a.text}>+ {a.text}</li>
                    ))}
                  </ul>
                )}
                {u.changelog && <pre className="max-h-28 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">{u.changelog}</pre>}
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={stage.isPending}
                onClick={() => stage.mutate({ repository: u.repository.id, id: u.id, version: u.version })}
              >
                Update
              </Button>
            </div>
          ))}
        </div>
      )}
      {dialog}
    </div>
  )
}

// ── Repositories ──────────────────────────────────────────────────────────────

export function RepositoriesTab() {
  const repos = useRepositories()
  const refresh = useRefreshPlugins()
  const [adding, setAdding] = useState(false)
  const check = useMutation({
    mutationFn: () => unwrap(api.POST('/admin/plugins/repositories/refresh', { body: {} })),
    onSuccess: () => {
      toast.success('Repositories checked')
      refresh()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  if (repos.isPending) return <Loading />
  if (repos.error) return <QueryError error={repos.error} title="Could not load the repositories" />
  const { repositories, official } = repos.data

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Checked every day, and a few minutes after the server starts.</p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={check.isPending} onClick={() => check.mutate()}>
            {check.isPending ? <Spinner /> : <RefreshCw />} Check now
          </Button>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus /> Add repository
          </Button>
        </div>
      </div>
      {!official && (
        <Alert>
          <Library />
          <AlertTitle>The official Playpex repository isn&apos;t published yet</AlertTitle>
          <AlertDescription>Once it is, it comes built in. It will never offer adults plugins.</AlertDescription>
        </Alert>
      )}
      {repositories.length === 0 ? (
        <Empty icon={<Library />} title="No repository">
          Add one with the address of its index (index.json), from its publisher.
        </Empty>
      ) : (
        repositories.map((r) => <RepositoryCard key={r.id} repository={r} />)
      )}
      <AddRepositoryDialog open={adding} onOpenChange={setAdding} />
    </div>
  )
}

function RepositoryCard({ repository: r }: { repository: Repository }) {
  const refresh = useRefreshPlugins()
  const enable = useMutation({
    mutationFn: (enabled: boolean) => unwrap(api.PATCH('/admin/plugins/repositories/{repositoryId}', { params: { path: { repositoryId: r.id } }, body: { enabled } })),
    onSuccess: (x) => {
      toast.success(`${x.name} is ${x.enabled ? 'on' : 'off'}`)
      refresh()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/admin/plugins/repositories/{repositoryId}', { params: { path: { repositoryId: r.id } } })),
    onSuccess: () => {
      toast.success(`${r.name} removed`)
      refresh()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const accept = useMutation({
    mutationFn: (key: string) => unwrap(api.POST('/admin/plugins/repositories/{repositoryId}/key', { params: { path: { repositoryId: r.id } }, body: { key } })),
    onSuccess: () => {
      toast.success(`${r.name}'s new key is trusted`)
      refresh()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <CardTitle className="flex flex-wrap items-center gap-2">
              {r.name}
              {r.builtin && (
                <Badge variant="secondary">
                  <ShieldCheck /> Official
                </Badge>
              )}
              {!r.enabled && <Badge variant="outline">Off</Badge>}
              {r.stale && <Badge variant="outline">Stale</Badge>}
            </CardTitle>
            <CardDescription className="break-all">{r.url}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={r.enabled} disabled={enable.isPending} onCheckedChange={(on) => enable.mutate(on)} aria-label={`${r.name} on`} />
            {!r.builtin && (
              <Confirm
                title={`Remove ${r.name}?`}
                description="Its plugins stay installed, but they won't get updates any more. You can add it again later."
                action="Remove"
                onConfirm={() => remove.mutate()}
                trigger={
                  <Button variant="ghost" size="icon" aria-label={`Remove ${r.name}`}>
                    <Trash2 />
                  </Button>
                }
              />
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[9rem_1fr]">
          <dt className="text-muted-foreground">Key fingerprint</dt>
          <dd>
            <Mono className="text-xs">{r.fingerprint}</Mono>
          </dd>
          <dt className="text-muted-foreground">Plugins</dt>
          <dd>
            {r.plugins}
            {r.refused.length > 0 && (
              <span className="text-muted-foreground">
                {' '}
                · {r.refused.length} left out: {r.refused.map((x) => x.name).join(', ')} ({r.refused[0].reason.toLowerCase()})
              </span>
            )}
          </dd>
          <dt className="text-muted-foreground">Last checked</dt>
          <dd>
            {r.checkedAt ? ago(r.checkedAt) : 'not yet'}
            {r.fetchedAt && r.fetchedAt !== r.checkedAt && <span className="text-muted-foreground"> · last good index {ago(r.fetchedAt)}</span>}
          </dd>
        </dl>
        {r.error && !r.pendingKey && (
          <p className="flex items-start gap-1.5 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {r.error}
            {r.stale && <span className="text-muted-foreground"> (its last good index is used)</span>}
          </p>
        )}
        {r.pendingKey && (
          <Alert variant="destructive">
            <KeyRound />
            <AlertTitle>Its index is signed with another key</AlertTitle>
            <AlertDescription>
              <p>
                New key <Mono className="text-xs">{r.pendingKey.fingerprint}</Mono>. Until you accept it, nothing new comes from this repository. Accept it only
                if its publisher announced a new key: otherwise someone else may be signing its index.
              </p>
              <Confirm
                title="Trust the new key?"
                description={`Plugins from ${r.name} will be checked with ${r.pendingKey.fingerprint} from now on.`}
                action="Trust the new key"
                onConfirm={() => accept.mutate(r.pendingKey!.key)}
                trigger={
                  <Button variant="outline" size="sm" className="mt-2">
                    Trust the new key
                  </Button>
                }
              />
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}

function AddRepositoryDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const refresh = useRefreshPlugins()
  const [url, setUrl] = useState('')
  const [preview, setPreview] = useState<RepositoryPreview | null>(null)
  const close = () => {
    setUrl('')
    setPreview(null)
    onOpenChange(false)
  }
  const look = useMutation({
    mutationFn: () => unwrap(api.POST('/admin/plugins/repositories/preview', { body: { url: url.trim() } })),
    onSuccess: setPreview,
    onError: (err) => toast.error(errorMessage(err)),
  })
  const add = useMutation({
    mutationFn: () => unwrap(api.POST('/admin/plugins/repositories', { body: { url: preview!.url, key: preview!.key } })),
    onSuccess: (r) => {
      toast.success(`${r.name} added: ${r.plugins} plugin${r.plugins === 1 ? '' : 's'} to browse`)
      refresh()
      close()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (/^https:\/\/\S+$/.test(url.trim())) look.mutate()
  }
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a repository</DialogTitle>
          <DialogDescription>The address of its index (…/index.json), as its publisher gives it.</DialogDescription>
        </DialogHeader>
        {!preview ? (
          <form onSubmit={submit} className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="repo-url">Index</Label>
              <Input id="repo-url" placeholder="https://plugins.example.org/index.json" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={!/^https:\/\/\S+$/.test(url.trim()) || look.isPending}>
                {look.isPending && <Spinner />} Look at it
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-muted-foreground">Name</dt>
                <dd className="font-medium">{preview.name}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Key fingerprint</dt>
                <dd>
                  <Mono>{preview.fingerprint}</Mono>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Plugins</dt>
                <dd>{preview.plugins}</dd>
              </div>
            </dl>
            <p className="text-xs text-muted-foreground">
              Compare the fingerprint with the one its publisher gives. Trusting it lets its plugins install without a signature of their own; an
              index later signed with another key waits for you.
            </p>
            {preview.problem && (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertTitle>Can&apos;t add it</AlertTitle>
                <AlertDescription>{preview.problem}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={() => setPreview(null)}>
                Back
              </Button>
              <Button disabled={!!preview.problem || add.isPending} onClick={() => add.mutate()}>
                {add.isPending && <Spinner />} Trust and add
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
