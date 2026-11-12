import { useMutation, useQuery } from '@tanstack/react-query'
import { Download, LogIn } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Spinner } from '@/components/common'
import { useRefreshPlugins } from '@/components/plugin-common'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, errorMessage, unwrap, type Schemas } from '@/lib/api'

// Stremio add-ons chosen from a list (docs/stremio-bridge-plan.md §5.4): the
// admin's Stremio account (Import from Stremio: the server signs in, reads
// the account's add-ons and signs out; nothing of the account is kept), or the
// add-ons a bridged add-on lists (its addon_catalog). The server keeps their
// addresses: this page only sees names and what each offers.

type Choice = Schemas['StremioAddonChoice']
type Item = Choice['addons'][number]

function offersOf(a: Item): string {
  const o = a.offers
  if (!o) return ''
  return [
    o.play && 'Play sources',
    o.subtitles && 'subtitles',
    o.catalogs ? `${o.catalogs} catalog${o.catalogs > 1 ? 's' : ''}` : null,
    o.titles && 'title pages',
  ]
    .filter(Boolean)
    .join(', ')
}

/** Ticks and installs: each chosen add-on through the bridge, one after another */
export function AddonPicker({ choice, onDone, compact }: { choice: Choice; onDone: () => void; compact?: boolean }) {
  const refresh = useRefreshPlugins()
  const [chosen, setChosen] = useState<string[]>(() => choice.addons.filter((a) => a.checked).map((a) => a.key))
  const install = useMutation({
    mutationFn: () =>
      unwrap(api.POST('/admin/plugins/managed/stremio/import/{session}', { params: { path: { session: choice.session! } }, body: { keys: chosen } })),
    onSuccess: (r) => {
      if (r.installed.length) toast.success(`${r.installed.length} add-on${r.installed.length > 1 ? 's' : ''} installed`)
      r.failed.forEach((f) => toast.error(`${f.name}: ${f.error}`))
      refresh()
      onDone()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const toggle = (key: string, on: boolean) => setChosen((c) => (on ? [...c, key] : c.filter((k) => k !== key)))
  if (!choice.addons.length) return <p className="text-sm text-muted-foreground">No add-ons there.</p>
  return (
    <div className="space-y-3">
      <ul className={`divide-y rounded-md border ${compact ? 'max-h-96' : 'max-h-[50vh]'} overflow-y-auto`}>
        {choice.addons.map((a) => {
          const disabled = !a.usable || !!a.installed
          return (
            <li key={a.key} className="flex items-start gap-3 px-3 py-2 text-sm">
              <Checkbox
                id={`addon-${a.key}`}
                className="mt-0.5"
                disabled={disabled}
                checked={chosen.includes(a.key)}
                onCheckedChange={(v) => toggle(a.key, v === true)}
              />
              <label htmlFor={`addon-${a.key}`} className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{a.name}</span>
                  {a.version && <span className="font-mono text-xs text-muted-foreground">{a.version}</span>}
                  {a.official && <Badge variant="outline">Stremio&apos;s own</Badge>}
                  {a.configured && <Badge variant="outline">Configured</Badge>}
                  {a.audience === 'adults' && <Badge variant="outline">Adults only</Badge>}
                  {a.installed && <Badge variant="secondary">Installed</Badge>}
                </div>
                <div className="text-xs text-muted-foreground">
                  {a.host}
                  {a.usable ? offersOf(a) && ` · ${offersOf(a)}` : a.reason && ` · ${a.reason}`}
                </div>
              </label>
            </li>
          )
        })}
      </ul>
      <div className="flex justify-end">
        <Button disabled={!chosen.length || install.isPending || !choice.session} onClick={() => install.mutate()}>
          {install.isPending ? <Spinner /> : <Download />} Install {chosen.length || ''}
        </Button>
      </div>
    </div>
  )
}

/** Install a plugin › Stremio add-on › Import from my Stremio account */
export function StremioImport({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [choice, setChoice] = useState<Choice | null>(null)
  const read = useMutation({
    mutationFn: () => unwrap(api.POST('/admin/plugins/managed/stremio/import', { body: { email: email.trim(), password } })),
    onSuccess: (r) => {
      setPassword('')
      setChoice(r)
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (email.trim() && password) read.mutate()
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>Import from Stremio</DialogTitle>
        <DialogDescription>
          {choice
            ? 'The add-ons of your Stremio account. Configured ones come with their configuration, kept as a secret.'
            : 'Playpex signs in to your Stremio account once, reads which add-ons you installed there and signs out. It keeps neither your password nor the session.'}
        </DialogDescription>
      </DialogHeader>
      {choice ? (
        <AddonPicker choice={choice} onDone={onDone} />
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="stremio-email">E-mail</Label>
            <Input id="stremio-email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="stremio-password">Password</Label>
            <Input id="stremio-password" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground">
            Stremio&apos;s account API isn&apos;t a documented public one: if it changes, importing stops working (adding add-ons by address doesn&apos;t).
          </p>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onBack}>
              Back
            </Button>
            <Button type="submit" disabled={!email.trim() || !password || read.isPending}>
              {read.isPending ? <Spinner /> : <LogIn />} Read my add-ons
            </Button>
          </DialogFooter>
        </form>
      )}
    </>
  )
}

/** A bridged add-on's page: the add-ons it lists (addon_catalog), when it lists some */
export function ListedAddons({ pluginId }: { pluginId: string }) {
  const listed = useQuery({
    queryKey: ['stremio-listed', pluginId],
    queryFn: () => unwrap(api.GET('/admin/plugins/{pluginId}/stremio/addons', { params: { path: { pluginId } } })),
    staleTime: 10 * 60 * 1000,
  })
  if (!listed.data || !listed.data.addons.length) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Add-ons it lists</CardTitle>
        <CardDescription>This add-on recommends these. Tick the ones to add: each becomes a plugin of its own.</CardDescription>
      </CardHeader>
      <CardContent>
        <AddonPicker choice={listed.data} compact onDone={() => listed.refetch()} />
      </CardContent>
    </Card>
  )
}
