import { AlertTriangle } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Navigate, useSearchParams } from 'react-router'
import { Spinner } from '@/components/common'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError, errorMessage } from '@/lib/api'
import { useSession, useSetupState, useSignIn } from '@/lib/auth'

export function AuthShell({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh items-center justify-center bg-[radial-gradient(ellipse_at_top,var(--color-muted),transparent_60%)] px-4 py-10">
      <div className="w-full max-w-md space-y-6">
        <div className="flex items-center justify-center gap-3">
          <img src="/logo.svg" alt="" className="size-9" />
          <span className="text-lg font-semibold tracking-tight">Playpex Media Server</span>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
      </div>
    </div>
  )
}

function safeNext(next: string | null) {
  // Only paths of this dashboard (no //host, no schemes)
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/'
}

export function LoginPage() {
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  const setup = useSetupState()
  const session = useSession()
  const signIn = useSignIn()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  if (setup.data?.needed) return <Navigate to="/setup" replace />
  if (session.data) return <Navigate to={next} replace />

  const submit = (e: FormEvent) => {
    e.preventDefault()
    signIn.mutate({ username: username.trim(), password })
  }
  const err = signIn.error
  const message =
    err instanceof ApiError && err.status === 429
      ? 'Too many attempts: wait a minute and try again.'
      : err instanceof ApiError && err.status === 401
        ? 'Wrong username or password.'
        : err
          ? errorMessage(err)
          : null

  return (
    <AuthShell
      title="Sign in"
      description={next.startsWith('/link') ? 'Sign in as the server’s admin to approve the device.' : 'Sign in as the server’s admin.'}
    >
      <form onSubmit={submit} className="space-y-4">
        {message && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          <Label htmlFor="username">Username</Label>
          <Input id="username" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <Button type="submit" className="w-full" disabled={signIn.isPending}>
          {signIn.isPending && <Spinner />} Sign in
        </Button>
        <p className="text-xs text-muted-foreground">
          Forgot it? On the server machine run <code className="font-mono">playpex-server admin set &lt;username&gt;</code>.
        </p>
      </form>
    </AuthShell>
  )
}
