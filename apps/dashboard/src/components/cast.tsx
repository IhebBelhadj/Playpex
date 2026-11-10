import { Cast as CastIcon, Monitor, Pause, Play, RotateCcw, RotateCw, Smartphone, Square, Tv } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  castDuration,
  setCastTarget,
  useCastCommand,
  useCastEvents,
  useCastTarget,
  useCastTo,
  useScreens,
  type CastRequest,
  type CastScreen,
} from '@/lib/cast'
import { clock } from '@/lib/format'
import { cn } from '@/lib/utils'

// Casting from the dashboard (docs/cast-plan.md step 3): the top bar's cast
// button (where Play sends: this browser or a screen), the bar of what plays on
// the screens (driven from here), and the player's "Continue on…" (watch.tsx).

const STATE_TEXT: Record<string, string> = {
  opening: 'Opening',
  playing: 'Playing',
  paused: 'Paused',
  buffering: 'Loading',
  ended: 'Ended',
  failed: 'Couldn’t play',
}

export function ScreenIcon({ kind, className }: { kind: CastScreen['kind']; className?: string }) {
  const Icon = kind === 'mobile' ? Smartphone : kind === 'tv' ? Tv : Monitor
  return <Icon className={className} />
}

function playingLine(s: CastScreen): string {
  if (!s.playing) return 'Nothing playing'
  return `${STATE_TEXT[s.playing.state] ?? s.playing.state}${s.playing.title ? ` · ${s.playing.title}` : ''}`
}

/** The screens as a list to pick from */
export function ScreenList({
  screens,
  chosen,
  onPick,
  here,
}: {
  screens: CastScreen[]
  chosen?: string | null
  onPick: (s: CastScreen | null) => void
  /** a first row for this browser ("Play here") */
  here?: string
}) {
  return (
    <div className="flex flex-col gap-1">
      {here && (
        <button
          type="button"
          onClick={() => onPick(null)}
          className={cn('flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left hover:bg-muted', !chosen && 'bg-muted')}
        >
          <Monitor className={cn('size-5 shrink-0', !chosen ? 'text-gold' : 'text-muted-foreground')} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{here}</span>
            <span className="block truncate text-xs text-muted-foreground">Opens the player in this window</span>
          </span>
        </button>
      )}
      {screens.map((s) => (
        <button
          key={s.deviceId}
          type="button"
          onClick={() => onPick(s)}
          className={cn('flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left hover:bg-muted', chosen === s.deviceId && 'bg-muted')}
        >
          <ScreenIcon kind={s.kind} className={cn('size-5 shrink-0', chosen === s.deviceId ? 'text-gold' : 'text-muted-foreground')} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{s.name}</span>
            <span className="block truncate text-xs text-muted-foreground">{playingLine(s)}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

function NoScreens() {
  return (
    <p className="px-3 py-2 text-sm text-muted-foreground">
      No screen is on. Open Playpex TV on a screen (Settings › Casting there lets devices cast to it).
    </p>
  )
}

/** The top bar's cast button: where Play sends */
export function CastButton() {
  const [open, setOpen] = useState(false)
  const target = useCastTarget()
  const screens = useScreens()
  const list = screens.data ?? []
  const online = target ? list.some((s) => s.deviceId === target.deviceId) : false
  // a screen chosen earlier that isn't on: Play stays here (its name kept for when it's back)
  const label = target ? (online ? `Playing on ${target.name}` : `${target.name} is off`) : 'Play on a screen'
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={label}>
              <CastIcon className={cn(target && online && 'text-gold')} />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 p-2">
        <p className="px-3 pt-1 pb-2 text-xs font-medium text-muted-foreground">Play on</p>
        <ScreenList
          screens={list}
          chosen={online ? target?.deviceId : null}
          here="This browser"
          onPick={(s) => {
            setCastTarget(s ? { deviceId: s.deviceId, name: s.name } : null)
            setOpen(false)
          }}
        />
        {!screens.isLoading && list.length === 0 && <NoScreens />}
      </PopoverContent>
    </Popover>
  )
}

/** What plays on the screens from casts, with its controls; under the page */
function useCastsPlaying() {
  const screens = useScreens()
  return (screens.data ?? []).filter((s) => s.playing?.castId && s.playing.state !== 'ended')
}

/** Room under the page for the bar, so it never covers the page's end */
export function CastSpacer() {
  const playing = useCastsPlaying()
  return playing.length ? <div aria-hidden style={{ height: `${playing.length * 4.25}rem` }} /> : null
}

export function CastBar() {
  useCastEvents()
  const playing = useCastsPlaying()
  if (!playing.length) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex flex-col items-center gap-2 px-3 pb-3 md:pl-[14.5rem]">
      {playing.map((s) => (
        <CastRow key={s.deviceId} screen={s} />
      ))}
    </div>
  )
}

function CastRow({ screen }: { screen: CastScreen }) {
  const command = useCastCommand()
  const p = screen.playing!
  const castId = p.castId!
  const paused = p.state === 'paused'
  const total = castDuration(castId)
  const send = (action: 'toggle' | 'seekBy' | 'stop', deltaS?: number) => command.mutate({ castId, action, deltaS })
  return (
    <div className="pointer-events-auto flex w-full max-w-xl items-center gap-3 rounded-xl bg-card py-2 pr-2 pl-4 shadow-lg ring-1 ring-border">
      <ScreenIcon kind={screen.kind} className="size-5 shrink-0 text-gold" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{p.title ?? 'Playing'}</p>
        <p className="truncate text-xs text-muted-foreground tabular-nums">
          {screen.name} · {STATE_TEXT[p.state] ?? p.state}
          {typeof p.positionS === 'number' && ` · ${clock(p.positionS)}${total ? ` / ${clock(total)}` : ''}`}
        </p>
      </div>
      <Button variant="ghost" size="icon-sm" aria-label="Back 10 seconds" className="hidden sm:inline-flex" onClick={() => send('seekBy', -10)}>
        <RotateCcw />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label={paused ? 'Play' : 'Pause'} onClick={() => send('toggle')}>
        {paused ? <Play /> : <Pause />}
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Forward 30 seconds" className="hidden sm:inline-flex" onClick={() => send('seekBy', 30)}>
        <RotateCw />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Stop" onClick={() => send('stop')}>
        <Square />
      </Button>
    </div>
  )
}

/** The player's "Continue on…": the screens; picking one hands playback over */
export function ContinueOnButton({ onPick, className }: { onPick: (s: CastScreen) => void; className?: string }) {
  const [open, setOpen] = useState(false)
  const screens = useScreens()
  const list = screens.data ?? []
  // menus open on the page's body: out of full screen first
  const toggle = (o: boolean) => {
    if (o && document.fullscreenElement) document.exitFullscreen().catch(() => {})
    setOpen(o)
  }
  return (
    <Popover open={open} onOpenChange={toggle}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Continue on a screen" title="Continue on a screen" className={className}>
          <CastIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-80 p-2">
        <p className="px-3 pt-1 pb-2 text-xs font-medium text-muted-foreground">Continue on</p>
        <ScreenList
          screens={list}
          onPick={(s) => {
            if (s) onPick(s)
            setOpen(false)
          }}
        />
        {!screens.isLoading && list.length === 0 && <NoScreens />}
      </PopoverContent>
    </Popover>
  )
}

/** "Play on a screen" for what only a screen plays (a YouTube video from a link): the screens, then cast */
export function PlayOnScreenButton({ request, label = 'Play on a screen' }: { request: CastRequest; label?: string }) {
  const [open, setOpen] = useState(false)
  const screens = useScreens()
  const castTo = useCastTo()
  const list = (screens.data ?? []).filter((s) => s.accepts.embed || !('embed' in request.source))
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs">
          <CastIcon /> {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        <p className="px-3 pt-1 pb-2 text-xs font-medium text-muted-foreground">Play on</p>
        <ScreenList
          screens={list}
          onPick={(s) => {
            if (s) castTo.mutate({ screen: s, request })
            setOpen(false)
          }}
        />
        {!screens.isLoading && list.length === 0 && <NoScreens />}
      </PopoverContent>
    </Popover>
  )
}
