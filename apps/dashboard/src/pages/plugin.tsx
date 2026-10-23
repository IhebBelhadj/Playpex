import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, BadgeCheck, Eraser, ExternalLink, History, MoreHorizontal, RotateCw, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { Confirm, Empty, Loading, Mono, QueryError, Spinner, Stat } from '@/components/common'
import { PluginAccounts } from '@/components/plugin-accounts'
import {
  ORIGIN,
  PackagePreview,
  PluginIcon,
  PluginStateBadge,
  every,
  useRefreshPlugins,
  type AdminPlugin,
  type Preview,
} from '@/components/plugin-common'
import { PluginProfiles, PluginServerSettings } from '@/components/plugin-settings'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { API_PREFIX, api, errorMessage, unwrap } from '@/lib/api'
import { ago, dateTime, time } from '@/lib/format'
import { EnableSwitch, usePlugins } from '@/pages/plugins'

// A plugin's own page (docs/plugins-plan.md §6.3): Overview (listing, origin,
// what it needs, changelog), Permissions, Settings (server scope), Profiles
// (per profile: shown or hidden, personal permissions, profile settings),
// Accounts, Activity (its counters since it started, jobs, its log lines),
// Versions (the version the last update replaced, put back by a rollback);
// Clear data and Remove. Everything a plugin may do is decided here, never
// on a client.

type Listing = {
  summary?: string
  description?: string
  disclaimer?: string
  license?: string
  source?: string
  categories?: string[]
  screenshots?: string[]
}

type Stats = {
  host?: Record<string, number>
  hooks?: Record<string, { calls: number; errors: number }>
  data?: Record<string, { calls: number; errors: number }>
  events?: { received: number; dropped: number; errors: number }
  notifications?: number
  loadedAt?: string | null
  sandbox?: { calls: number; errors: number; timeouts: number; cpuMs: number } | null
}

export function PluginPage() {
  const { pluginId = '' } = useParams()
  const [tab, setTab] = useState('overview')
  const query = useQuery({
    queryKey: ['admin-plugin', pluginId],
    queryFn: () => unwrap(api.GET('/admin/plugins/{pluginId}', { params: { path: { pluginId } } })),
    // its counters and jobs move while Activity is open
    refetchInterval: tab === 'activity' ? 5000 : false,
  })
  const list = usePlugins()

  if (query.isPending) return <Loading />
  if (query.error) return <QueryError error={query.error} title="Could not load this plugin" />
  const p = query.data
  const dev = p.origin === 'dev'
  const tabs: [string, string, boolean][] = [
    ['overview', 'Overview', true],
    ['permissions', 'Permissions', true],
    ['settings', 'Settings', (p.settings ?? 0) > 0],
    ['profiles', 'Profiles', true],
    ['accounts', 'Accounts', (p.links ?? 0) > 0],
    ['activity', 'Activity', true],
    ['versions', 'Versions', !dev],
  ]

  return (
    <div className="space-y-6">
      <Link to="/plugins" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Plugins
      </Link>
      <div className="flex flex-wrap items-start gap-4">
        <PluginIcon src={p.icon ? API_PREFIX + p.icon : null} className="size-14" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{p.name}</h1>
            <span className="font-mono text-sm text-muted-foreground">{p.version}</span>
            <PluginStateBadge plugin={p} />
          </div>
          {p.description && <p className="text-sm text-muted-foreground">{p.description}</p>}
          {p.error && p.state !== 'disabled' && (
            <p className="flex items-start gap-1.5 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {p.error}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <EnableSwitch plugin={p} />
          <Actions plugin={p} />
        </div>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap">
          {tabs
            .filter((t) => t[2])
            .map(([value, label]) => (
              <TabsTrigger key={value} value={value}>
                {label}
              </TabsTrigger>
            ))}
        </TabsList>
        <TabsContent value="overview">
          <Overview plugin={p} />
        </TabsContent>
        <TabsContent value="permissions">
          <PermissionsTab plugin={p} />
        </TabsContent>
        <TabsContent value="settings">
          <Panel title="Settings" description="What this plugin lets you choose for the whole server. Clients only see what it then shows.">
            <PluginServerSettings plugin={p.id} />
          </Panel>
        </TabsContent>
        <TabsContent value="profiles">
          <Panel
            title="Profiles"
            description={
              p.audience === 'adults'
                ? 'For each profile: whether it uses this plugin, what the plugin may do for it and its own settings. Kids profiles never get an adults plugin.'
                : 'For each profile: whether it uses this plugin, what the plugin may do for it and its own settings.'
            }
          >
            <PluginProfiles plugin={p.id} />
          </Panel>
        </TabsContent>
        <TabsContent value="accounts">
          <Panel title="Accounts" description="The accounts it uses on other services, linked from here and never from a client.">
            <PluginAccounts plugin={p.id} />
          </Panel>
        </TabsContent>
        <TabsContent value="activity">
          <Activity plugin={p} />
        </TabsContent>
        <TabsContent value="versions">
          <Versions plugin={p} developerMode={!!list.data?.developerMode} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function Panel({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-2 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  )
}

// ── actions ───────────────────────────────────────────────────────────────────

function Actions({ plugin: p }: { plugin: AdminPlugin }) {
  const refresh = useRefreshPlugins()
  const navigate = useNavigate()
  const dev = p.origin === 'dev'
  const reload = useMutation({
    mutationFn: () => unwrap(api.POST('/admin/plugins/{pluginId}/reload', { params: { path: { pluginId: p.id } } })),
    onSuccess: (r) => {
      toast.success(r.state === 'enabled' ? `${r.name} reloaded` : `${r.name} didn't start: ${r.error}`)
      refresh()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const clear = useMutation({
    mutationFn: () => unwrap(api.POST('/admin/plugins/{pluginId}/clear', { params: { path: { pluginId: p.id } } })),
    onSuccess: () => {
      toast.success(`${p.name}'s data cleared`)
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
      navigate('/plugins')
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label="More">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {dev && (
          <DropdownMenuItem disabled={reload.isPending} onSelect={() => reload.mutate()}>
            <RotateCw /> Reload from its folder
          </DropdownMenuItem>
        )}
        <Confirm
          title={`Clear ${p.name}'s data?`}
          description="Everything it kept goes: its storage, the secrets and settings entered for it, its linked accounts, what each profile allowed it and its notifications. It starts again as if just installed. What it added to watch lists or downloads stays."
          action="Clear data"
          onConfirm={() => clear.mutate()}
          trigger={
            <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
              <Eraser /> Clear data
            </DropdownMenuItem>
          }
        />
        {!dev && (
          <>
            <DropdownMenuSeparator />
            <Confirm
              title={`Remove ${p.name}, keep its data?`}
              description="Its files go; its storage, secrets, accounts and settings stay, for when you install it again."
              action="Remove"
              onConfirm={() => remove.mutate(true)}
              trigger={<DropdownMenuItem onSelect={(e) => e.preventDefault()}>Remove, keep its data</DropdownMenuItem>}
            />
            <Confirm
              title={`Remove ${p.name}?`}
              description="Its files go, and everything it kept: its storage, secrets, linked accounts and settings. What it added to watch lists or downloads stays. Library folders it recognised go back to Playpex's own matching."
              action="Remove"
              onConfirm={() => remove.mutate(false)}
              trigger={
                <DropdownMenuItem variant="destructive" onSelect={(e) => e.preventDefault()}>
                  <Trash2 /> Remove
                </DropdownMenuItem>
              }
            />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ── tabs ──────────────────────────────────────────────────────────────────────

function Overview({ plugin: p }: { plugin: AdminPlugin }) {
  const listing = (p.listing ?? {}) as Listing
  const running = p.state === 'enabled'
  return (
    <div className="space-y-6">
      <Panel title="About">
        {listing.description && <p className="mb-4 text-sm whitespace-pre-line">{listing.description}</p>}
        {listing.disclaimer && <p className="mb-4 rounded-md bg-muted p-3 text-xs text-muted-foreground">{listing.disclaimer}</p>}
        <dl className="divide-y">
          <Row label="Publisher">{p.publisher?.name ?? '—'}</Row>
          <Row label="Origin">
            {ORIGIN[p.origin]}
            {p.source && (
              <span className="block text-xs break-all text-muted-foreground" title={p.source}>
                {p.source}
              </span>
            )}
          </Row>
          {p.origin !== 'dev' && (
            <Row label="Signature">
              {p.signer ? (
                <span className="inline-flex items-center gap-1.5">
                  <BadgeCheck className="size-4" /> A trusted publisher key <Mono className="text-xs">{p.signer}</Mono>
                </span>
              ) : (
                'Unsigned (installed in developer mode)'
              )}
            </Row>
          )}
          <Row label="For">{p.audience === 'adults' ? 'Adults only: never kids profiles' : 'Every profile'}</Row>
          {listing.categories && listing.categories.length > 0 && (
            <Row label="Kind">
              <div className="flex flex-wrap gap-1.5">
                {listing.categories.map((c) => (
                  <Badge key={c} variant="outline">
                    {c}
                  </Badge>
                ))}
              </div>
            </Row>
          )}
          {listing.license && <Row label="License">{listing.license}</Row>}
          {listing.source && (
            <Row label="Source code">
              <a href={listing.source} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2">
                {listing.source} <ExternalLink className="size-3.5" />
              </a>
            </Row>
          )}
          {p.installedAt && <Row label="Installed">{dateTime(p.installedAt)}</Row>}
          {p.updatedAt && p.updatedAt !== p.installedAt && <Row label="Updated">{dateTime(p.updatedAt)}</Row>}
          <Row label="Needs">
            {(p.requires ?? []).length === 0
              ? 'No other plugin'
              : (p.requires ?? []).map((r) => (
                  <div key={r.id}>
                    <Mono>{r.id}</Mono> {r.version}
                    {r.optional ? ' (optional)' : ''}
                  </div>
                ))}
          </Row>
          {(p.exports ?? []).length > 0 && <Row label="Offers to other plugins">{(p.exports ?? []).join(', ')}</Row>}
        </dl>
      </Panel>
      {listing.screenshots && listing.screenshots.length > 0 && running && (
        <Panel title="Screenshots">
          <div className="grid gap-3 sm:grid-cols-2">
            {listing.screenshots.map((s) => (
              <img
                key={s}
                src={`${API_PREFIX}/plugins/${p.id}/assets/${s.replace(/^assets\//, '')}`}
                alt=""
                className="w-full rounded-md border bg-muted"
              />
            ))}
          </div>
        </Panel>
      )}
      {p.changelog && (
        <Panel title="Changes">
          <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">{p.changelog}</pre>
        </Panel>
      )}
    </div>
  )
}

function PermissionsTab({ plugin: p }: { plugin: AdminPlugin }) {
  const shared = p.permissions.filter((x) => !x.personal)
  const personal = p.permissions.filter((x) => x.personal)
  return (
    <Panel title="What it may do" description="Accepted when it was installed. An update asking for more waits for you to accept it.">
      {p.permissions.length === 0 ? (
        <p className="text-sm text-muted-foreground">It asks for nothing.</p>
      ) : (
        <div className="space-y-5">
          {shared.length > 0 && (
            <ul className="space-y-1.5 text-sm">
              {shared.map((perm) => (
                <li key={perm.key + perm.text} className="flex gap-2">
                  <span className="text-muted-foreground">•</span> {perm.text}
                </li>
              ))}
            </ul>
          )}
          {personal.length > 0 && (
            <div>
              <div className="mb-1.5 text-sm font-medium">For each profile, once you allow it in Profiles</div>
              <ul className="space-y-1.5 text-sm">
                {personal.map((perm) => (
                  <li key={perm.key + perm.text} className="flex gap-2">
                    <span className="text-muted-foreground">•</span> {perm.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {p.hooks.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Takes part in: <Mono className="text-xs">{p.hooks.join(', ')}</Mono>
            </p>
          )}
        </div>
      )}
    </Panel>
  )
}

function Counts({ title, rows }: { title: string; rows: [string, ReactNode][] }) {
  if (!rows.length) return null
  return (
    <div>
      <div className="mb-1.5 text-sm font-medium">{title}</div>
      <div className="divide-y rounded-md border">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-4 px-3 py-1.5 text-sm">
            <span className="min-w-0 truncate">{label}</span>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">{value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Activity({ plugin: p }: { plugin: AdminPlugin }) {
  const logs = useQuery({
    queryKey: ['logs', 'plugin', p.id],
    queryFn: () => unwrap(api.GET('/admin/logs', { params: { query: { area: 'plugins', plugin: p.id, limit: 200 } } })),
    refetchInterval: 10000,
  })
  const s = (p.stats ?? null) as Stats | null
  const host = Object.entries(s?.host ?? {})
  const calls = (table?: Record<string, { calls: number; errors: number }>): [string, ReactNode][] =>
    Object.entries(table ?? {}).map(([name, c]) => [name, c.errors ? `${c.calls} · ${c.errors} failed` : String(c.calls)])

  return (
    <div className="space-y-6">
      <Panel
        title="Since it started"
        description={s?.loadedAt ? `Counted from ${dateTime(s.loadedAt)}; they start again with the plugin.` : 'It isn\'t running.'}
      >
        {s ? (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-4">
              <Stat label="Calls" value={s.sandbox?.calls ?? 0} />
              <Stat label="CPU time" value={`${Math.round(s.sandbox?.cpuMs ?? 0)} ms`} />
              <Stat label="Failed" value={s.sandbox?.errors ?? 0} />
              <Stat label="Too slow" value={s.sandbox?.timeouts ?? 0} />
            </div>
            <div className="grid gap-5 md:grid-cols-2">
              <Counts
                title="Requests"
                rows={host.filter(([k]) => k.startsWith('http ')).map(([k, v]) => [k.slice(5), v] as [string, ReactNode])}
              />
              <Counts
                title="Request failures"
                rows={host.filter(([k]) => k.startsWith('http.')).map(([k, v]) => [k.slice(5), v] as [string, ReactNode])}
              />
              <Counts
                title="Writes"
                rows={host.filter(([k]) => k.startsWith('write ')).map(([k, v]) => [k.slice(6), v] as [string, ReactNode])}
              />
              <Counts title="Hooks" rows={calls(s.hooks)} />
              <Counts title="Screens and rows" rows={calls(s.data)} />
              <Counts
                title="Other"
                rows={[
                  ...(s.events ? [['Events received', `${s.events.received}${s.events.dropped ? ` · ${s.events.dropped} dropped` : ''}`] as [string, ReactNode]] : []),
                  ...(s.notifications ? [['Notifications sent', s.notifications] as [string, ReactNode]] : []),
                  ...host.filter(([k]) => !/^(http[ .]|write )/.test(k)).map(([k, v]) => [k, v] as [string, ReactNode]),
                ]}
              />
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Turn it on to see what it does.</p>
        )}
      </Panel>
      {(p.jobs ?? []).length > 0 && (
        <Panel title="Scheduled jobs">
          <div className="divide-y rounded-md border">
            {(p.jobs ?? []).map((job) => (
              <div key={job.name} className="space-y-0.5 px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{job.name}</span>
                  <span className="text-xs text-muted-foreground">every {every(job.intervalMs)}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {job.running ? 'Running now' : job.lastRunAt ? `Last ${ago(job.lastRunAt)} (${job.lastDurationMs} ms)` : 'Not run yet'}
                  {` · ${job.runs} runs`}
                  {job.errors > 0 && ` · ${job.errors} failed`}
                  {job.skipped > 0 && ` · ${job.skipped} skipped`}
                  {job.nextRunAt && ` · next ${ago(job.nextRunAt)}`}
                </p>
                {job.lastError && <p className="text-xs text-destructive">{job.lastError}</p>}
              </div>
            ))}
          </div>
        </Panel>
      )}
      <Panel title="Log" description="Its latest lines (the whole log: Logs).">
        {logs.isPending ? (
          <Loading rows={2} />
        ) : logs.error ? (
          <QueryError error={logs.error} title="Could not load its log" />
        ) : logs.data.entries.length === 0 ? (
          <Empty title="Nothing logged">Nothing from this plugin since the server started.</Empty>
        ) : (
          <div className="max-h-96 overflow-auto rounded-md border font-mono text-xs">
            {[...logs.data.entries].reverse().map((e, i) => (
              <div key={i} className="flex gap-3 border-b px-3 py-1 last:border-0">
                <span className="shrink-0 text-muted-foreground">{time(e.time)}</span>
                <span className={`w-10 shrink-0 ${e.level === 'error' ? 'text-destructive' : e.level === 'warn' ? 'text-warning' : 'text-muted-foreground'}`}>
                  {e.level}
                </span>
                <span className="min-w-0 break-words">{e.msg}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  )
}

function Versions({ plugin: p, developerMode }: { plugin: AdminPlugin; developerMode: boolean }) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const rollback = useMutation({
    mutationFn: () => unwrap(api.POST('/admin/plugins/{pluginId}/rollback', { params: { path: { pluginId: p.id } } })),
    onSuccess: setPreview,
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <Panel title="Versions" description="The version an update replaces is kept on this server, to go back to it.">
      <div className="divide-y rounded-md border">
        <div className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
          <span>
            <span className="font-mono">{p.version}</span> <Badge variant="secondary">Installed</Badge>
          </span>
          {p.updatedAt && <span className="text-xs text-muted-foreground">{ago(p.updatedAt)}</span>}
        </div>
        {p.previousVersion ? (
          <div className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
            <span>
              <span className="font-mono">{p.previousVersion}</span> <span className="text-muted-foreground">kept by the last update</span>
            </span>
            <Button variant="outline" size="sm" disabled={rollback.isPending} onClick={() => rollback.mutate()}>
              {rollback.isPending ? <Spinner /> : <History />} Put it back
            </Button>
          </div>
        ) : (
          <p className="px-3 py-2 text-sm text-muted-foreground">No earlier version is kept: one is after its next update.</p>
        )}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Other versions: install their package from the Plugins page. Repositories (later) will list every version they offer.
      </p>
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
    </Panel>
  )
}
