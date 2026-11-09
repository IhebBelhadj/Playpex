import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Gamepad2,
  Hand,
  MonitorSmartphone,
  Move,
  Pause,
  RotateCcw,
  RotateCw,
  Undo2,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { Dot, Empty, Loading, PageHeader, QueryError } from '@/components/common'
import { RemoteFieldBar } from '@/components/remote-field'
import { Touchpad, type TouchpadHandle } from '@/components/remote-touchpad'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useRemote, useRemoteTargets, type RemoteInput, type RemotePhase, type RemoteState } from '@/lib/remote'
import { cn } from '@/lib/utils'

// The dashboard as the TV's remote (docs/remote-control-plan.md §2.7): /remote lists the devices
// that can be controlled now, /remote/:deviceId is the controller.

export function RemoteTargetsPage() {
  const targets = useRemoteTargets()
  if (targets.isPending) return <Loading />
  if (targets.error) return <QueryError error={targets.error} />
  return (
    <>
      <PageHeader title="Remote control" description="Drive a device's screen from here with a touchpad, your mouse and keyboard, or arrows." />
      {targets.data.length === 0 ? (
        <Empty icon={<Gamepad2 />} title="No device can be controlled now">
          Playpex TV can be controlled while it runs, when its Settings › Remote control allows it.
        </Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {targets.data.map((t) => {
            const can = [t.capabilities.pointer && 'pointer', t.capabilities.keyboard && 'keys', t.capabilities.text && 'text']
              .filter(Boolean)
              .join(', ')
            return (
              <Card key={t.deviceId}>
                <CardContent className="flex items-center gap-3">
                  <MonitorSmartphone className="size-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Dot state="ok" />
                      <span className="truncate font-medium">{t.name ?? 'Unnamed device'}</span>
                      {!t.paired && <Badge variant="outline">Local</Badge>}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {[t.client, can && `takes ${can}`].filter(Boolean).join(' · ')}
                      {t.controller ? ` · controlled by ${t.controller.name ?? 'an admin'}` : ''}
                    </p>
                  </div>
                  <Button asChild>
                    <Link to={`/remote/${encodeURIComponent(t.deviceId)}`}>
                      <Gamepad2 /> Control
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </>
  )
}


// ── the controller ────────────────────────────────────────────────────────
//
// Phones: the touchpad fills the screen, Click and Back under it like a laptop's buttons, the
// playback keys and a switch to big arrows at the bottom. Desktop: the touchpad is a miniature of
// the TV's screen (its shape, its pointer); a click captures the mouse and the keyboard for the TV
// (remote-touchpad.tsx), the arrows beside it.

const HOLD_DELAY = 400
const HOLD_EVERY = 100

/** A button that holds a key: down on press, repeats while held (the TV scrubs on held arrows), up on release */
function KeyButton({
  keyName,
  code,
  send,
  disabled,
  label,
  className,
  children,
}: {
  keyName: string
  code?: string
  send: (msg: RemoteInput) => void
  disabled: boolean
  label: string
  className?: string
  children: ReactNode
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const held = useRef(false)
  const [pressed, setPressed] = useState(false)

  const release = useCallback(() => {
    clearTimeout(timer.current)
    clearInterval(timer.current)
    if (!held.current) return
    held.current = false
    setPressed(false)
    send({ type: 'key', phase: 'up', key: keyName, code })
  }, [send, keyName, code])

  useEffect(() => release, [release])
  useEffect(() => {
    if (disabled) release()
  }, [disabled, release])

  return (
    <Button
      type="button"
      variant="secondary"
      aria-label={label}
      title={label}
      disabled={disabled}
      data-pressed={pressed || undefined}
      className={cn('size-16 touch-none select-none rounded-full data-pressed:bg-foreground/20 [&_svg:not([class*=size-])]:size-6', className)}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          // no capture: the release still comes through pointerup
        }
        held.current = true
        setPressed(true)
        navigator.vibrate?.(8)
        send({ type: 'key', phase: 'down', key: keyName, code })
        timer.current = setTimeout(() => {
          timer.current = setInterval(() => send({ type: 'key', phase: 'down', key: keyName, code, repeat: true }), HOLD_EVERY)
        }, HOLD_DELAY)
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => {
        // from the keyboard (Enter / Space on the focused button): a press
        if (e.detail === 0 && !held.current) {
          send({ type: 'key', phase: 'down', key: keyName, code })
          send({ type: 'key', phase: 'up', key: keyName, code })
        }
      }}
    >
      {children}
    </Button>
  )
}

/** The touchpad's click button: held, it holds the TV's mouse button (drag with a second finger) */
function ClickButton({ send, disabled, className }: { send: (msg: RemoteInput) => void; disabled: boolean; className?: string }) {
  const held = useRef(false)
  const [pressed, setPressed] = useState(false)
  const release = useCallback(() => {
    if (!held.current) return
    held.current = false
    setPressed(false)
    send({ type: 'pointer', phase: 'up', button: 'left' })
  }, [send])
  useEffect(() => release, [release])
  return (
    <button
      type="button"
      disabled={disabled}
      data-pressed={pressed || undefined}
      className={cn(
        'touch-none select-none bg-secondary text-sm font-medium transition-colors data-pressed:bg-foreground/20 disabled:opacity-50',
        className,
      )}
      onPointerDown={(e) => {
        e.preventDefault()
        held.current = true
        setPressed(true)
        navigator.vibrate?.(8)
        send({ type: 'pointer', phase: 'down', button: 'left' })
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={release}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => {
        if (e.detail === 0) {
          send({ type: 'pointer', phase: 'down', button: 'left' })
          send({ type: 'pointer', phase: 'up', button: 'left' })
        }
      }}
    >
      Click
    </button>
  )
}

function statusOf(phase: RemotePhase, state: RemoteState | null, name: string): { tone: 'ok' | 'warn' | 'idle' | 'error'; text: string } {
  switch (phase) {
    case 'connecting':
      return { tone: 'idle', text: 'Connecting…' }
    case 'retrying':
      return { tone: 'warn', text: 'Connection lost, trying again…' }
    case 'taken':
      return { tone: 'warn', text: 'Another admin took over' }
    case 'refused':
      return { tone: 'error', text: 'The server refused remote control' }
    case 'ended':
      return { tone: 'idle', text: 'Remote control ended' }
  }
  if (state?.connected) return { tone: 'ok', text: 'Connected' }
  if (state?.reason === 'unsupported') return { tone: 'error', text: `${name} doesn't take remote input` }
  if (!state) return { tone: 'idle', text: 'Connecting…' }
  return { tone: 'warn', text: 'Offline, waiting for it to come back' }
}

const TONE = { ok: 'ok', warn: 'warn', idle: 'idle', error: 'bad' } as const

const WIDE = '(min-width: 48rem)'
/** The desktop layout (md and up) */
function useWide() {
  return useSyncExternalStore(
    (change) => {
      const query = matchMedia(WIDE)
      query.addEventListener('change', change)
      return () => query.removeEventListener('change', change)
    },
    () => matchMedia(WIDE).matches,
  )
}

export function RemoteControlPage() {
  const { deviceId = '' } = useParams()
  // a fresh controller (socket, state, keys held) per device
  return <Controller key={deviceId} deviceId={deviceId} />
}

function Controller({ deviceId }: { deviceId: string }) {
  const targets = useRemoteTargets()
  const target = targets.data?.find((t) => t.deviceId === deviceId)
  const pad = useRef<TouchpadHandle>(null)
  const onCursor = useCallback((x: number, y: number) => pad.current?.cursor(x, y), [])
  const { phase, state, send, connect, live, direct, field } = useRemote(deviceId, onCursor)
  const wide = useWide()
  const name = state?.device?.name ?? target?.name ?? 'This device'
  const caps = state?.capabilities ?? target?.capabilities ?? null
  const screen = state?.screen ?? target?.screen ?? null
  const status = statusOf(phase, state, name)
  const stopped = phase === 'taken' || phase === 'refused' || phase === 'ended'
  const pointer = caps?.pointer !== false
  // phones: the touchpad, or big arrows (also the only choice for a device without a pointer)
  const [arrows, setArrows] = useState(false)
  const showArrows = arrows || !pointer

  const keys = live && !!caps?.keyboard
  const k = { send, disabled: !keys }
  // a text field open on the device: typed from here (this phone's keyboard)
  const typing = live && field ? <RemoteFieldBar key={field.id} field={field} send={send} name={name} /> : null

  const dpad = (big: boolean) => {
    const size = big ? 'size-20 [&_svg:not([class*=size-])]:size-8' : undefined
    return (
      <div className="grid grid-cols-3 gap-2">
        <span />
        <KeyButton {...k} keyName="ArrowUp" code="ArrowUp" label="Up" className={size}>
          <ChevronUp />
        </KeyButton>
        <span />
        <KeyButton {...k} keyName="ArrowLeft" code="ArrowLeft" label="Left" className={size}>
          <ChevronLeft />
        </KeyButton>
        <KeyButton
          {...k}
          keyName="Enter"
          code="Enter"
          label="OK"
          className={cn('bg-primary text-primary-foreground hover:bg-primary/85 data-pressed:bg-primary/70', size)}
        >
          <span className="text-base font-semibold">OK</span>
        </KeyButton>
        <KeyButton {...k} keyName="ArrowRight" code="ArrowRight" label="Right" className={size}>
          <ChevronRight />
        </KeyButton>
        <span />
        <KeyButton {...k} keyName="ArrowDown" code="ArrowDown" label="Down" className={size}>
          <ChevronDown />
        </KeyButton>
        <span />
      </div>
    )
  }

  const playback = (withBack: boolean) => (
    <div className="flex items-center gap-2">
      {withBack && (
        <KeyButton {...k} keyName="Escape" code="Escape" label="Back">
          <Undo2 />
        </KeyButton>
      )}
      <KeyButton {...k} keyName="MediaRewind" label="Back 10 seconds" className="size-12 md:size-16">
        <RotateCcw />
      </KeyButton>
      <KeyButton {...k} keyName="MediaPlayPause" label="Play / pause" className="size-12 md:size-16">
        <Pause />
      </KeyButton>
      <KeyButton {...k} keyName="MediaFastForward" label="Forward 10 seconds" className="size-12 md:size-16">
        <RotateCw />
      </KeyButton>
    </div>
  )

  const header = (
    <div className="flex items-center gap-2">
      <Button asChild variant="ghost" size="icon" className="-ml-2 shrink-0" aria-label="All devices">
        <Link to="/remote">
          <ArrowLeft />
        </Link>
      </Button>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-lg font-semibold tracking-tight md:text-xl">{name}</h1>
        <p className="flex items-center gap-2 text-xs text-muted-foreground md:text-sm" role="status" aria-live="polite">
          <Dot state={TONE[status.tone]} />
          <span className="truncate">{status.text}</span>
          {live && direct && (
            <span className="shrink-0" title="The pointer goes straight to the device (WebRTC), not through the server">
              · Direct
            </span>
          )}
        </p>
      </div>
      {stopped && (
        <Button size="sm" variant="outline" onClick={connect}>
          {phase === 'taken' ? 'Take back' : phase === 'ended' ? 'Connect again' : 'Try again'}
        </Button>
      )}
    </div>
  )

  if (wide) {
    return (
      <div className="space-y-6">
        {header}
        {typing}
        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_auto]">
          {pointer ? (
            <Touchpad ref={pad} send={send} enabled={live && !!caps?.pointer} screen={screen} name={name} />
          ) : (
            <p className="text-sm text-muted-foreground">{name} takes keys only: use the arrows.</p>
          )}
          <div className="flex flex-col items-center gap-6 lg:pt-4">
            {dpad(false)}
            {playback(true)}
            <p className="max-w-56 text-center text-xs text-muted-foreground">Right click on the touchpad also goes back.</p>
          </div>
        </div>
      </div>
    )
  }

  // the page's height on a phone: the screen under the top bar (3.5rem) and the page's padding (3rem)
  return (
    <div className="flex h-[calc(100svh-6.5rem)] min-h-[28rem] flex-col gap-3">
      {header}
      {typing}
      {showArrows ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8">
          {dpad(true)}
          <KeyButton {...k} keyName="Escape" code="Escape" label="Back" className="h-14 w-40 rounded-full">
            <Undo2 /> <span className="text-base">Back</span>
          </KeyButton>
        </div>
      ) : (
        // the pad and its two buttons, one object like a laptop's
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-3xl">
          <Touchpad ref={pad} send={send} enabled={live && !!caps?.pointer} screen={screen} name={name} fill className="min-h-0 flex-1 rounded-b-none" />
          <div className="grid h-16 shrink-0 grid-cols-2 gap-px border-t bg-border">
            <ClickButton send={send} disabled={!live || !caps?.pointer} />
            <KeyButton {...k} keyName="Escape" code="Escape" label="Back" className="h-full w-full rounded-none bg-secondary text-sm font-medium">
              Back
            </KeyButton>
          </div>
        </div>
      )}
      <div className="flex shrink-0 items-center justify-between gap-2">
        {playback(false)}
        {pointer && (
          <Button variant="outline" className="h-12 rounded-full px-4" onClick={() => setArrows((a) => !a)}>
            {showArrows ? <Hand /> : <Move />}
            {showArrows ? 'Touchpad' : 'Arrows'}
          </Button>
        )}
      </div>
    </div>
  )
}
