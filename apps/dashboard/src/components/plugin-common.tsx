import { useMutation, useQueryClient } from '@tanstack/react-query'
import { BadgeCheck, Puzzle, ShieldAlert, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Spinner } from '@/components/common'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api, errorMessage, unwrap, type Schemas } from '@/lib/api'
import { bytes } from '@/lib/format'

// What the Plugins page and a plugin's own page share (docs/plugins-plan.md
// §6.3): its icon and state, and a package's preview before it's installed
// (an upload, a link, or the version kept by the last update: a rollback).

export type AdminPlugin = Schemas['AdminPlugin']
export type Preview = Schemas['PluginPackagePreview']

export const ORIGIN: Record<AdminPlugin['origin'], string> = { upload: 'Uploaded', url: 'From a URL', dev: 'Developer copy' }

/** 900000 → "15 min" */
export function every(ms: number): string {
  if (ms >= 86400000 && ms % 86400000 === 0) return `${ms / 86400000} d`
  if (ms >= 3600000) return `${Math.round((ms / 3600000) * 10) / 10} h`
  if (ms >= 60000) return `${Math.round(ms / 60000)} min`
  return `${Math.round(ms / 1000)} s`
}

/** After a change: the plugin lists, its page, and the library (its information providers) */
export function useRefreshPlugins() {
  const client = useQueryClient()
  return () => {
    client.invalidateQueries({ queryKey: ['admin-plugins'] })
    client.invalidateQueries({ queryKey: ['admin-plugin'] })
    client.invalidateQueries({ queryKey: ['admin-plugin-settings'] })
    client.invalidateQueries({ queryKey: ['library'] })
  }
}

export function PluginStateBadge({ plugin: p }: { plugin: AdminPlugin }) {
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

export function PluginIcon({ src, className }: { src?: string | null; className?: string }) {
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

function Permissions({ list }: { list: Preview['permissions'] }) {
  return (
    <ul className="space-y-1 text-sm">
      {list.map((perm) => (
        <li key={perm.key} className="flex gap-2">
          <span className="text-muted-foreground">•</span> {perm.text}
        </li>
      ))}
    </ul>
  )
}

const CHANGE: Record<Preview['change'], string> = {
  install: 'Install',
  update: 'Update',
  downgrade: 'Install older version',
  reinstall: 'Reinstall',
}

/**
 * A staged package, as a dialog's content: what it is, what it may do (what
 * it asks for beyond the installed version first: installing accepts them),
 * where it comes from, whether it can be installed now; Cancel forgets it
 */
export function PackagePreview({
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
  const refresh = useRefreshPlugins()
  const client = useQueryClient()
  const grows = p.added.length > 0
  const install = useMutation({
    mutationFn: () =>
      unwrap(api.POST('/admin/plugins/packages/{token}/install', { params: { path: { token: p.token } }, body: grows ? { accept: true } : {} })),
    onSuccess: (r) => {
      const what = p.rollback ? `${r.name} ${r.version} is back` : `${r.name} ${r.version} installed`
      toast.success(!r.enabled ? `${what} (off)` : r.state === 'enabled' ? what : `${what}, but it didn't start`)
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
  const kept = p.permissions.filter((x) => !p.added.some((a) => a.key === x.key && a.text === x.text))

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-3">
          <PluginIcon src={p.icon} />
          <div className="min-w-0">
            <DialogTitle>
              {p.rollback ? 'Put back ' : ''}
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
        {p.rollback && (
          <p className="text-sm text-muted-foreground">
            The version the last update replaced, kept on this server. {p.current} is kept in turn, to go forward again.
          </p>
        )}
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
        {!p.rollback && (
          <div className="space-y-1 text-xs text-muted-foreground">
            <div className="break-all">From {p.source}</div>
            {p.resolved && <div className="break-all">Downloaded: {p.resolved}</div>}
            {p.root && <div className="break-all">Found in the folder {p.root}</div>}
          </div>
        )}
        {grows && (
          <Alert>
            <ShieldAlert />
            <AlertTitle>It asks for more than {p.current}</AlertTitle>
            <AlertDescription>
              <Permissions list={p.added} />
              <p>
                {p.change === 'install' ? 'Installing' : 'Updating'} accepts these. What it does for a profile (its events, writing to
                its lists) stays off until you switch it on in the plugin&apos;s Profiles.
              </p>
            </AlertDescription>
          </Alert>
        )}
        <div>
          <div className="mb-1.5 text-sm font-medium">{grows ? 'And, as before' : 'What it may do'}</div>
          {kept.length === 0 ? <p className="text-sm text-muted-foreground">Asks for nothing</p> : <Permissions list={kept} />}
        </div>
        {p.removed.length > 0 && (
          <div>
            <div className="mb-1.5 text-sm font-medium">No longer</div>
            <div className="text-muted-foreground">
              <Permissions list={p.removed} />
            </div>
          </div>
        )}
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
          {install.isPending && <Spinner />} {p.rollback ? 'Put it back' : grows ? `Accept and ${CHANGE[p.change].toLowerCase()}` : CHANGE[p.change]}
        </Button>
      </DialogFooter>
    </>
  )
}
