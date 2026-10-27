import { useQuery } from '@tanstack/react-query'
import { Activity, AlertTriangle, ArrowDown, ArrowLeftRight, ArrowUp, Clapperboard, Download, Info, Search, LayoutDashboard, LogOut, Menu, MonitorSmartphone, Puzzle, ScrollText, Settings, Users } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Dot, Spinner } from '@/components/common'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api, unwrap, type PairingRequest } from '@/lib/api'
import { adminName, useSession, useSetupState, useSignOut } from '@/lib/auth'
import { EventsProvider, useEvent, useEventsConnected } from '@/lib/events'
import { speed } from '@/lib/format'
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
  return (
    <EventsProvider enabled>{children}</EventsProvider>
  )
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

// The nav in groups: what's watched, who watches, the server itself
const NAV: {
  group?: string
  items: { to: string; label: string; icon: typeof Activity; end?: boolean }[]
}[] = [
  { items: [{ to: '/', label: 'Overview', icon: LayoutDashboard, end: true }] },
  {
    group: 'Media',
    items: [
      { to: '/library', label: 'Library', icon: Clapperboard },
      { to: '/search', label: 'Search', icon: Search },
      { to: '/downloads', label: 'Downloads', icon: Download },
    ],
  },
  {
    group: 'People',
    items: [
      { to: '/activity', label: 'Activity', icon: Activity },
      { to: '/devices', label: 'Devices', icon: MonitorSmartphone },
      { to: '/profiles', label: 'Profiles', icon: Users },
    ],
  },
  {
    group: 'Server',
    items: [
      { to: '/plugins', label: 'Plugins', icon: Puzzle },
      { to: '/settings', label: 'Settings', icon: Settings },
      { to: '/logs', label: 'Logs', icon: ScrollText },
      { to: '/about', label: 'About', icon: Info },
    ],
  },
]

const WIDE = ['/downloads', '/library']

// The active item is its label in full ink and its icon in gold: no pill, no bar
function Nav({ pending, onNavigate }: { pending: number; onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-6">
      {NAV.map(({ group, items }, i) => (
        <div key={group ?? i} className="flex flex-col">
          {group && <p className="px-3 pb-1.5 text-xs text-muted-foreground/80">{group}</p>}
          {items.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'flex h-[34px] items-center gap-3 rounded-full px-3 text-sm text-muted-foreground transition-colors hover:text-foreground',
                  isActive && 'font-medium text-foreground [&_svg]:text-gold',
                )
              }
            >
              <Icon className="size-4 text-muted-foreground/80" />
              <span className="flex-1">{label}</span>
              {to === '/devices' && pending > 0 && (
                <span className="text-xs font-medium text-gold tabular-nums" aria-label={`${pending} waiting`}>
                  {pending}
                </span>
              )}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  )
}

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2.5 px-3">
      <img src="/logo.svg" alt="" className="size-[22px]" />
      <span className="text-[17px] font-medium tracking-tight">Playpex</span>
    </Link>
  )
}

// The top bar's field: a title, a magnet or a link → Search
function QuickSearch() {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  return (
    <form
      role="search"
      className="relative w-full max-w-md"
      onSubmit={(e) => {
        e.preventDefault()
        const text = q.trim()
        navigate(text ? `/search?q=${encodeURIComponent(text)}` : '/search')
        setQ('')
      }}
    >
      <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search titles, or paste a link"
        aria-label="Search"
        className="border-transparent bg-muted pl-9 dark:bg-muted"
      />
    </form>
  )
}

// Opened from the Playpex Server Manager app (apps/manager): it adds this to the
// WebView's user agent. Its server list is the app's own page, https://localhost.
const IN_MANAGER = /PlaypexManager\//.test(navigator.userAgent)

// The server this dashboard runs, whether live updates flow, and the admin's sign-out
function ServerCorner({ name, traffic }: { name?: string; traffic?: { down: number; up: number } }) {
  const session = useSession()
  const signOut = useSignOut()
  const navigate = useNavigate()
  const connected = useEventsConnected()
  return (
    <div className="flex items-center gap-3 self-stretch md:gap-4">
      {traffic && (
        <Link to="/downloads" className="hidden items-center gap-3 text-sm tabular-nums text-muted-foreground hover:text-foreground lg:flex" aria-label="Traffic">
          <span className="flex items-center gap-1">
            <ArrowDown className="size-3.5 text-down" />
            {speed(traffic.down)}
          </span>
          <span className="flex items-center gap-1">
            <ArrowUp className="size-3.5 text-up" />
            {speed(traffic.up)}
          </span>
        </Link>
      )}
      <span className="hidden h-full border-l lg:block" aria-hidden />
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex min-w-0 items-center gap-2 text-sm">
            <Dot state={connected ? 'ok' : 'warn'} />
            <span className="truncate font-medium">{name ?? 'Media server'}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>{connected ? 'Live updates on' : 'Reconnecting to the server…'}</TooltipContent>
      </Tooltip>
      <span className="hidden text-sm text-muted-foreground sm:inline">{adminName(session.data)}</span>
      {IN_MANAGER && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Switch server" onClick={() => (location.href = 'https://localhost/#pick')}>
              <ArrowLeftRight />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Switch server</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Sign out" onClick={() => signOut.mutate(undefined, { onSettled: () => navigate('/login') })}>
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
      action: {
        label: 'Review',
        onClick: () => navigate(`/link?user_code=${encodeURIComponent(r?.userCode ?? '')}`),
      },
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
  const column = WIDE.some((p) => location.pathname.startsWith(p)) ? 'max-w-[110rem]' : 'max-w-6xl'

  useEffect(() => {
    document.title = name ? `${name} · Playpex` : 'Playpex Media Server'
  }, [name])

  return (
    <div className="min-h-svh md:grid md:grid-cols-[13.75rem_minmax(0,1fr)]">
      <PairingToasts />
      {/* the shell: sidebar and top bar on the page's own ground, split by 1px rules */}
      <aside className="sticky top-0 hidden h-svh flex-col border-r bg-sidebar md:flex">
        <div className="flex h-16 shrink-0 items-center">
          <Brand />
        </div>
        <div className="flex-1 overflow-y-auto px-2 pt-4 pb-6">
          <Nav pending={pending} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        {/* the bar's rule runs the whole width; its contents keep the page's column */}
        <header className="sticky top-0 z-20 h-14 shrink-0 border-b bg-background md:h-16">
          <div className={cn('mx-auto flex h-full w-full items-center gap-3 px-4 md:px-8', column)}>
            <Sheet open={open} onOpenChange={setOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Menu" className="-ml-2 md:hidden">
                  <Menu />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="flex w-64 flex-col gap-4 py-5">
                <SheetTitle className="sr-only">Menu</SheetTitle>
                <Brand />
                <div className="flex-1 overflow-y-auto px-2">
                  <Nav pending={pending} onNavigate={() => setOpen(false)} />
                </div>
              </SheetContent>
            </Sheet>
            <div className="md:hidden">
              <Brand />
            </div>
            <div className="hidden flex-1 md:block">{!location.pathname.startsWith('/search') && <QuickSearch />}</div>
            <div className="ml-auto flex h-full items-center">
              <ServerCorner
                name={name}
                traffic={
                  overview.data
                    ? {
                        down: overview.data.network.downloadSpeed,
                        up: overview.data.network.uploadSpeed,
                      }
                    : undefined
                }
              />
            </div>
          </div>
        </header>

        {/* the torrent client and the file browser use the whole width; the others a column, centred
            in the space beside the sidebar */}
        <main className={cn('mx-auto w-full min-w-0 space-y-6 px-4 py-6 md:px-8 md:py-7', column)}>
          {recovery && !location.pathname.startsWith('/settings') && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>Recovery mode: port {recovery.port} is in use</AlertTitle>
              <AlertDescription>
                <p>
                  {recovery.owner ? `${recovery.owner.name ?? 'Another program'} (pid ${recovery.owner.pid}) holds it. ` : 'Another program holds it. '}
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
    </div>
  )
}
