import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Link2, Unlink } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Confirm, Empty, Loading, QueryError, Spinner } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, errorMessage, unwrap, type Schemas } from '@/lib/api'
import { ago } from '@/lib/format'

// A plugin's account links (docs/plugins-plan.md §4.8), linked from here and
// never from a client: one row per profile (scope profile) or the server's.
// "Link" starts it on the server: a device code to enter on the service's
// page (the server polls for the token), or a custom link's code or form;
// the dialog asks how it's going every 3 s until it's done or failed.

type PluginLink = Schemas['PluginLink']
type Account = PluginLink['accounts'][number]
type Start = Schemas['PluginLinkStart']

export function PluginAccounts({ plugin }: { plugin: string }) {
  const query = useQuery({
    queryKey: ['admin-plugin-links', plugin],
    queryFn: () => unwrap(api.GET('/admin/plugins/{pluginId}/links', { params: { path: { pluginId: plugin } } })),
  })
  const [linking, setLinking] = useState<{ link: PluginLink; account: Account } | null>(null)

  if (query.isPending) return <Loading />
  if (query.error) return <QueryError error={query.error} title="Could not load its accounts" />
  if (!query.data.links.length) return <Empty title="No accounts">This plugin doesn&apos;t link accounts.</Empty>

  return (
    <div className="space-y-6 pt-2">
      {query.data.links.map((link) => (
        <section key={link.name} className="space-y-2">
          <h3 className="text-sm font-medium">{link.label}</h3>
          <p className="text-xs text-muted-foreground">
            {link.scope === 'profile' ? 'One account per profile.' : 'One account for the whole server.'}
          </p>
          <div className="divide-y rounded-md border">
            {link.accounts.map((account) => (
              <AccountRow
                key={account.profileId ?? 'server'}
                plugin={plugin}
                link={link}
                account={account}
                onLink={() => setLinking({ link, account })}
              />
            ))}
          </div>
        </section>
      ))}
      {linking && <LinkDialog plugin={plugin} link={linking.link} account={linking.account} onClose={() => setLinking(null)} />}
    </div>
  )
}

function AccountRow({ plugin, link, account, onLink }: { plugin: string; link: PluginLink; account: Account; onLink: () => void }) {
  const client = useQueryClient()
  const unlink = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE('/admin/plugins/{pluginId}/links/{name}', {
          params: { path: { pluginId: plugin, name: link.name }, query: account.profileId ? { profile: account.profileId } : {} },
        }),
      ),
    onSuccess: () => {
      toast.success(`${link.label} unlinked`)
      client.invalidateQueries({ queryKey: ['admin-plugin-links', plugin] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const who = account.profileName ?? 'This server'
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm">{who}</p>
        <p className="text-xs text-muted-foreground">
          {account.linked
            ? `Linked${account.linkedAt ? ' ' + ago(account.linkedAt) : ''}${account.expiresAt ? ` · token renews before ${new Date(account.expiresAt).toLocaleString()}` : ''}`
            : account.pending
              ? 'Waiting for the code to be entered'
              : 'Not linked'}
        </p>
      </div>
      {account.linked ? (
        <>
          <Badge variant="outline">Linked</Badge>
          <Confirm
            title={`Unlink ${who}'s ${link.label} account?`}
            description="Its tokens are deleted on this server. The plugin can't use the account until it's linked again."
            action="Unlink"
            onConfirm={() => unlink.mutate()}
            trigger={
              <Button variant="ghost" size="sm" disabled={unlink.isPending}>
                <Unlink /> Unlink
              </Button>
            }
          />
        </>
      ) : (
        <Button variant="outline" size="sm" onClick={onLink}>
          <Link2 /> Link
        </Button>
      )}
    </div>
  )
}

function LinkDialog({ plugin, link, account, onClose }: { plugin: string; link: PluginLink; account: Account; onClose: () => void }) {
  const client = useQueryClient()
  const profile = account.profileId ?? undefined
  const path = { pluginId: plugin, name: link.name }
  const [started, setStarted] = useState<Start | null>(null)
  const [state, setState] = useState<{ state: string; message: string | null }>({ state: 'pending', message: null })
  const [values, setValues] = useState<Record<string, string>>({})

  const start = useMutation({
    mutationFn: () => unwrap(api.POST('/admin/plugins/{pluginId}/links/{name}/start', { params: { path }, body: profile ? { profile } : {} })),
    onSuccess: setStarted,
    onError: (err) => setState({ state: 'failed', message: errorMessage(err) }),
  })
  const submit = useMutation({
    mutationFn: () =>
      unwrap(api.POST('/admin/plugins/{pluginId}/links/{name}/submit', { params: { path }, body: { ...(profile ? { profile } : {}), values } })),
    onSuccess: setState,
    onError: (err) => toast.error(errorMessage(err)),
  })

  // start once, when the dialog opens
  const { mutate: begin } = start
  useEffect(() => begin(), [begin])

  // a code: how it's going, every 3 s
  useEffect(() => {
    if (started?.kind !== 'code' || state.state !== 'pending') return
    const timer = setInterval(() => {
      unwrap(api.GET('/admin/plugins/{pluginId}/links/{name}/progress', { params: { path, query: profile ? { profile } : {} } }))
        .then((r) => {
          if (r.state !== 'pending' && r.state !== 'none') setState(r)
        })
        .catch(() => {})
    }, 3000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, state.state])

  useEffect(() => {
    if (state.state === 'done') {
      toast.success(`${link.label} linked${account.profileName ? ` for ${account.profileName}` : ''}`)
      client.invalidateQueries({ queryKey: ['admin-plugin-links', plugin] })
      onClose()
    }
  }, [state.state, link.label, account.profileName, client, plugin, onClose])

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Link {link.label}
            {account.profileName ? ` for ${account.profileName}` : ''}
          </DialogTitle>
          <DialogDescription>
            {started?.kind === 'form'
              ? started.help || 'Fill in what the service gave you.'
              : 'On a phone or computer, open the address below, sign in with the account to link and enter the code.'}
          </DialogDescription>
        </DialogHeader>

        {state.state === 'failed' ? (
          <p className="text-sm text-destructive">{state.message || "Linking didn't work."}</p>
        ) : !started ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Asking {link.label} for a code…
          </div>
        ) : started.kind === 'code' ? (
          <div className="space-y-4">
            <p className="text-center font-mono text-3xl tracking-widest">{started.code}</p>
            <a
              className="flex items-center justify-center gap-1.5 text-sm underline underline-offset-2"
              href={started.urlComplete || started.url}
              target="_blank"
              rel="noreferrer"
            >
              {started.url} <ExternalLink className="size-3.5" />
            </a>
            <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <Spinner /> Waiting for the code to be entered (until {new Date(started.expiresAt).toLocaleTimeString()})
            </p>
          </div>
        ) : (
          <form
            id="link-form"
            className="space-y-3"
            onSubmit={(e: FormEvent) => {
              e.preventDefault()
              submit.mutate()
            }}
          >
            {started.form.map((f) => (
              <div key={f.key} className="space-y-1.5">
                <Label htmlFor={`link-${f.key}`}>{f.label}</Label>
                <Input
                  id={`link-${f.key}`}
                  type={f.secret ? 'password' : 'text'}
                  autoComplete="off"
                  value={values[f.key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                />
                {f.help && <p className="text-xs text-muted-foreground">{f.help}</p>}
              </div>
            ))}
            {state.state === 'pending' && state.message && <p className="text-xs text-muted-foreground">{state.message}</p>}
          </form>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {state.state === 'failed' ? 'Close' : 'Cancel'}
          </Button>
          {state.state === 'failed' && (
            <Button
              variant="outline"
              onClick={() => {
                setStarted(null)
                setState({ state: 'pending', message: null })
                start.mutate()
              }}
            >
              Try again
            </Button>
          )}
          {started?.kind === 'form' && state.state !== 'failed' && (
            <Button type="submit" form="link-form" disabled={submit.isPending}>
              Link
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
