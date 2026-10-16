import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, FolderCheck, FolderX } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Spinner } from '@/components/common'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { api, errorMessage, unwrap } from '@/lib/api'
import { useSession, useSetupState, useSignIn } from '@/lib/auth'
import { bytes } from '@/lib/format'
import { restartServer } from '@/lib/restart'
import { AuthShell } from './login'

// First-run setup (plan §7): 1. the admin account (only from the server
// machine), 2. server name, download directory, LAN sharing, TMDB key.

function AccountStep() {
  const client = useQueryClient()
  const signIn = useSignIn()
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const create = useMutation({
    mutationFn: async () => {
      await unwrap(api.POST('/admin/setup', { body: { username: username.trim(), password } }))
      await signIn.mutateAsync({ username: username.trim(), password })
    },
    onSuccess: () => client.invalidateQueries(),
  })
  const mismatch = again.length > 0 && again !== password
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!mismatch) create.mutate()
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      {create.error && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>{errorMessage(create.error)}</AlertDescription>
        </Alert>
      )}
      <div className="space-y-2">
        <Label htmlFor="username">Admin username</Label>
        <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)} pattern="[a-zA-Z0-9_.]{3,30}" title="3 to 30 letters, digits, _ or ." required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input id="password" type="password" autoComplete="new-password" minLength={8} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} required />
        <p className="text-xs text-muted-foreground">At least 8 characters. Needed to open this dashboard and approve devices.</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="again">Password again</Label>
        <Input id="again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} aria-invalid={mismatch} required />
        {mismatch && <p className="text-xs text-destructive">The passwords differ.</p>}
      </div>
      <Button type="submit" className="w-full" disabled={create.isPending || mismatch}>
        {create.isPending && <Spinner />} Create the admin account
      </Button>
    </form>
  )
}

function ServerStep() {
  const navigate = useNavigate()
  const client = useQueryClient()
  const current = useQuery({ queryKey: ['settings'], queryFn: () => unwrap(api.GET('/admin/settings')) })
  const overview = useQuery({ queryKey: ['overview'], queryFn: () => unwrap(api.GET('/admin/overview')) })
  const [name, setName] = useState<string | null>(null)
  const [dir, setDir] = useState<string | null>(null)
  const [lan, setLan] = useState<boolean | null>(null)
  const [tmdb, setTmdb] = useState('')
  const check = useMutation({ mutationFn: (d: string) => unwrap(api.POST('/admin/storage/check', { body: { dir: d } })) })
  const save = useMutation({
    mutationFn: async () => {
      const s = current.data!.settings
      const result = await unwrap(
        api.PUT('/admin/settings', {
          body: {
            general: { serverName: name ?? s.general.serverName },
            storage: { downloadDir: dir ?? s.storage.downloadDir },
            network: { lanSharing: lan ?? s.network.lanSharing },
            ...(tmdb.trim() ? { providers: { tmdbApiKey: tmdb.trim() } } : {}),
          },
        }),
      )
      if (result.restartRequired.length) {
        await restartServer()
      }
      return result
    },
    onSuccess: () => {
      client.invalidateQueries()
      toast.success('The server is set up')
      navigate('/')
    },
  })

  if (current.isPending) return <Spinner />
  if (current.error) return <p className="text-sm text-destructive">{errorMessage(current.error)}</p>
  const s = current.data.settings
  const defaultDir = overview.data?.disks.find((d) => d.id === 'downloads')?.path ?? ''
  const dirValue = dir ?? s.storage.downloadDir
  const locked = (key: string) => current.data.sources[key] === 'env'

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
      className="space-y-5"
    >
      {save.error && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>{errorMessage(save.error)}</AlertDescription>
        </Alert>
      )}
      <div className="space-y-2">
        <Label htmlFor="name">Server name</Label>
        <Input id="name" value={name ?? s.general.serverName} onChange={(e) => setName(e.target.value)} required />
        <p className="text-xs text-muted-foreground">What clients show when they find this server.</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="dir">Download directory</Label>
        <div className="flex gap-2">
          <Input
            id="dir"
            className="font-mono text-xs"
            placeholder={defaultDir || 'default'}
            value={dirValue}
            disabled={locked('storage.downloadDir')}
            onChange={(e) => {
              setDir(e.target.value)
              check.reset()
            }}
          />
          <Button type="button" variant="outline" disabled={!dirValue && !defaultDir} onClick={() => check.mutate(dirValue || defaultDir)}>
            Check
          </Button>
        </div>
        {check.data ? (
          <p className={`flex items-center gap-1.5 text-xs ${check.data.writable ? 'text-success' : 'text-destructive'}`}>
            {check.data.writable ? <FolderCheck className="size-3.5" /> : <FolderX className="size-3.5" />}
            {check.data.writable
              ? `${check.data.exists ? 'Writable' : 'Will be created'} · ${bytes(check.data.free)} free of ${bytes(check.data.total)}`
              : 'Not writable by the server'}
          </p>
        ) : check.error ? (
          <p className="text-xs text-destructive">{errorMessage(check.error)}</p>
        ) : (
          <p className="text-xs text-muted-foreground">Empty = the default ({defaultDir || 'the cache folder'}). Torrents are streamed from here.</p>
        )}
      </div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <Label htmlFor="lan">Share on the local network</Label>
          <p className="mt-1 text-xs text-muted-foreground">Devices on your network can pair with this server. Off = only this machine.</p>
        </div>
        <Switch id="lan" checked={lan ?? s.network.lanSharing} disabled={locked('network.lanSharing')} onCheckedChange={setLan} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="tmdb">TMDB API key (optional)</Label>
        <Input id="tmdb" placeholder={s.providers.tmdbApiKey || 'not set'} value={tmdb} disabled={locked('providers.tmdbApiKey')} onChange={(e) => setTmdb(e.target.value)} />
        <p className="text-xs text-muted-foreground">
          For recommendations and the 18+ catalog. Free key at{' '}
          <a className="underline underline-offset-2" href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">
            themoviedb.org
          </a>
          .
        </p>
      </div>
      <Button type="submit" className="w-full" disabled={save.isPending}>
        {save.isPending ? <Spinner /> : <Check />} Finish setup
      </Button>
    </form>
  )
}

export function SetupPage() {
  const setup = useSetupState()
  const session = useSession()
  if (setup.isPending || session.isPending) {
    return (
      <div className="flex h-svh items-center justify-center">
        <Spinner className="size-6" />
      </div>
    )
  }
  if (setup.data?.needed) {
    if (!setup.data.local) {
      return (
        <AuthShell title="Set up this server" description="The server has no admin account yet.">
          <Alert>
            <AlertTriangle />
            <AlertTitle>Open this page on the server machine</AlertTitle>
            <AlertDescription>
              For safety the admin account can only be created from the machine the server runs on: open{' '}
              <code className="font-mono">http://localhost:{location.port || 80}/</code> there, or run{' '}
              <code className="font-mono">playpex-server admin set &lt;username&gt;</code>.
            </AlertDescription>
          </Alert>
        </AuthShell>
      )
    }
    return (
      <AuthShell title="Welcome to Playpex" description="Step 1 of 2 · Create the admin account of this server.">
        <AccountStep />
      </AuthShell>
    )
  }
  if (!session.data) {
    // Right after the account step the session is still being fetched
    return session.isFetching ? (
      <div className="flex h-svh items-center justify-center">
        <Spinner className="size-6" />
      </div>
    ) : (
      <Navigate to="/login" replace />
    )
  }
  return (
    <AuthShell title="Your server" description="Step 2 of 2 · A few settings; everything can be changed later in Settings.">
      <ServerStep />
    </AuthShell>
  )
}
