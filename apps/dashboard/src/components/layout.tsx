import { useQuery } from '@tanstack/react-query'
import { Activity, AlertTriangle, Download, HardDrive, Info, LayoutDashboard, LogOut, Menu, MonitorSmartphone, ScrollText, Settings, Users } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Dot, Spinner } from '@/components/common'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api, unwrap, type PairingRequest } from '@/lib/api'
import { adminName, useSession, useSetupState, useSignOut } from '@/lib/auth'
import { EventsProvider, useEvent, useEventsConnected } from '@/lib/events'
import { cn } from '@/lib/utils'

/** Sends to /setup while the admin has no password, to /login when signed out. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const location = useLocation()
  const setup = useSetupState()
  const session = useSession()
  if (setup.isPending || session.isPending) {
    return (
      <div className="flex h-svh items-center justify-center">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    )
  }
  if (setup.data?.needed) {
    return <Navigate to="/setup" replace />
  }
  if (!session.data) {
    const next = location.pathname + location.search
    return <Navigate to={next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`} replace />
  }
  return <EventsProvider enabled>{children}</EventsProvider>
}

export function useOverview() {
  return useQuery({
    queryKey: ['overview'],
    queryFn: () => unwrap(api.GET('/admin/overview')),
    refetchInterval: 5000,
  })
}

export function usePairingRequests() {
  return useQuery({
    queryKey: ['pairing'],
    queryFn: () => unwrap(api.GET('/admin/pairing')).then((r) => r.requests),
    refetchInterval: 15_000,
  })
}

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/activity', label: 'Activity', icon: Activity },
  { to: '/devices', label: 'Devices', icon: MonitorSmartphone },
  { to: '/downloads', label: 'Downloads', icon: Download },
  { to: '/storage', label: 'Storage', icon: HardDrive },
  { to: '/logs', label: 'Logs', icon: ScrollText },
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/profiles', label: 'Profiles', icon: Users },
  { to: '/about', label: 'About', icon: Info },
]

function Nav({ pending, onNavigate }: { pending: number; onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-0.5">
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
              isActive && 'bg-muted font-medium text-foreground',
            )
          }
        >
          <Icon className="size-4" />
          <span className="flex-1">{label}</span>
          {to === '/devices' && pending > 0 && <Badge>{pending}</Badge>}
        </NavLink>
      ))}
    </nav>
  )
}

function Brand({ name }: { name?: string }) {
  return (
    <div className="flex items-center gap-2.5 px-2.5">
      <img src="/logo.svg" alt="" className="size-6" />
      <div className="min-w-0 leading-tight">
        <div className="text-sm font-semibold">Playpex</div>
        <div className="truncate text-xs text-muted-foreground">{name ?? 'Media Server'}</div>
      </div>
    </div>
  )
}

function Footer() {
  const session = useSession()
  const signOut = useSignOut()
  const navigate = useNavigate()
  const connected = useEventsConnected()
  return (
    <div className="flex items-center gap-2 border-t px-2.5 pt-3">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex items-center">
            <Dot state={connected ? 'ok' : 'warn'} />
          </span>
        </TooltipTrigger>
        <TooltipContent>{connected ? 'Live updates on' : 'Reconnecting to the server…'}</TooltipContent>
      </Tooltip>
      <span className="flex-1 truncate text-sm">{adminName(session.data)}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Sign out"
            onClick={() => signOut.mutate(undefined, { onSettled: () => navigate('/login') })}
          >
            <LogOut />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Sign out</TooltipContent>
      </Tooltip>
    </div>
  )
}

/** A toast for every new pairing request, wherever the admin is. */
function PairingToasts() {
  const navigate = useNavigate()
  useEvent<PairingRequest>('pairing.requested', (event) => {
    const r = event.data
    toast.info('A device asks to pair', {
      description: `${r?.client ?? r?.clientId ?? 'A client'} from ${r?.address ?? 'the network'}: code ${r?.userCode ?? ''}`,
      action: { label: 'Review', onClick: () => navigate(`/link?user_code=${encodeURIComponent(r?.userCode ?? '')}`) },
      duration: 15_000,
    })
  })
  return null
}

export function AppLayout() {
  const overview = useOverview()
  const pairing = usePairingRequests()
  const [open, setOpen] = useState(false)
  const location = useLocation()
  const name = overview.data?.server.name
  const recovery = overview.data?.server.recovery
  const pending = pairing.data?.length ?? 0

  useEffect(() => {
    document.title = name ? `${name} · Playpex` : 'Playpex Media Server'
  }, [name])

  return (
    <div className="min-h-svh md:grid md:grid-cols-[15rem_1fr]">
      <PairingToasts />
      <aside className="sticky top-0 hidden h-svh flex-col gap-6 border-r bg-sidebar py-4 md:flex">
        <Brand name={name} />
        <div className="flex-1 overflow-y-auto px-2">
          <Nav pending={pending} />
        </div>
        <Footer />
      </aside>

      <header className="sticky top-0 z-20 flex items-center gap-2 border-b bg-background/90 px-4 py-2 backdrop-blur md:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Menu">
              <Menu />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="flex w-64 flex-col gap-6 py-4">
            <SheetTitle className="sr-only">Menu</SheetTitle>
            <Brand name={name} />
            <div className="flex-1 px-2">
              <Nav pending={pending} onNavigate={() => setOpen(false)} />
            </div>
            <Footer />
          </SheetContent>
        </Sheet>
        <Brand name={name} />
      </header>

      <main className="mx-auto w-full max-w-6xl min-w-0 space-y-6 px-4 py-6 md:px-8 md:py-8">
        {recovery && !location.pathname.startsWith('/settings') && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Recovery mode: port {recovery.port} is in use</AlertTitle>
            <AlertDescription>
              <p>
                {recovery.owner
                  ? `${recovery.owner.name ?? 'Another program'} (pid ${recovery.owner.pid}) holds it. `
                  : 'Another program holds it. '}
                Clients aren't served until the server listens on a free port.
              </p>
              <Button asChild size="sm" variant="outline" className="mt-2">
                <NavLink to="/settings/general">Choose another port</NavLink>
              </Button>
            </AlertDescription>
          </Alert>
        )}
        <Outlet />
      </main>
    </div>
  )
}
