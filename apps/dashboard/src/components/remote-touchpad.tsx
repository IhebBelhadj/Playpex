import { MousePointer2 } from 'lucide-react'
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { cn } from '@/lib/utils'
import { modifiersOf, type RemoteInput } from '@/lib/remote'

// The remote's touchpad (docs/remote-control-plan.md §2.7).
//
// Touch: drag = move (relative, accelerated like a laptop's pad), tap = click, long press or
// two-finger tap = right click (Back on the TV), two-finger drag = wheel.
//
// Mouse: a click captures it (pointer lock), so it never leaves the pad and reaches every edge of
// the TV; then its moves, buttons and wheel and the keyboard's keys go to the TV, scaled so that
// crossing this screen crosses the TV's. Esc gives them back (the browser's own rule for a locked
// pointer). Moves and wheel are summed and sent once per animation frame.

type Button = 'left' | 'right' | 'middle' | 'back'

export interface TouchpadHandle {
  /** The target's cursor, 0–1 of its screen */
  cursor(x: number, y: number): void
}

const TAP_MS = 250
const LONG_MS = 550
const SLOP = 8 // CSS px a finger may wiggle and still tap
const MOUSE_BUTTONS: Record<number, Button | undefined> = { 0: 'left', 1: 'middle', 2: 'right', 3: 'back' }

// How far the TV's pointer goes for a finger's move: faster moves go further
function gain(distance: number, ms: number) {
  const speed = distance / Math.max(ms, 1) // px / ms
  return 1.8 + Math.min(2.6, speed * 1.5)
}

interface Finger {
  x: number
  y: number
  t: number
  startX: number
  startY: number
}

export function Touchpad({
  send,
  enabled,
  screen,
  name,
  fill = false,
  ref,
  className,
}: {
  send: (msg: RemoteInput) => void
  enabled: boolean
  screen: { width?: number; height?: number } | null | undefined
  /** The device's name, for the hints */
  name: string
  /** Fill the height it's given (phones) instead of the TV screen's shape */
  fill?: boolean
  ref?: Ref<TouchpadHandle>
  className?: string
}) {
  const pad = useRef<HTMLDivElement>(null)
  const dot = useRef<HTMLDivElement>(null)
  const [locked, setLocked] = useState(false)
  const latest = useRef({ send, enabled, screen })
  useEffect(() => {
    latest.current = { send, enabled, screen }
  })

  useImperativeHandle(ref, () => ({
    cursor(x, y) {
      const el = dot.current
      if (!el) return
      el.style.left = `${Math.max(0, Math.min(1, x)) * 100}%`
      el.style.top = `${Math.max(0, Math.min(1, y)) * 100}%`
      el.style.opacity = '1'
    },
  }))

  // nothing to control any more: give the mouse back
  useEffect(() => {
    if (!enabled && document.pointerLockElement === pad.current) document.exitPointerLock()
  }, [enabled])

  useEffect(() => {
    const el = pad.current
    if (!el) return
    const fingers = new Map<number, Finger>()
    let move = { dx: 0, dy: 0 }
    let wheel = { dx: 0, dy: 0 }
    let frame = 0
    let longPress: ReturnType<typeof setTimeout> | undefined
    // the gesture since the first finger came down
    let gesture: { start: number; moved: boolean; most: number; done: boolean } | null = null
    // what's held on the TV while the mouse is captured, let go when it's released
    const buttons = new Set<Button>()
    const keys = new Map<string, string | undefined>()

    const out = (msg: RemoteInput) => {
      if (latest.current.enabled) latest.current.send(msg)
    }
    const flush = () => {
      frame = 0
      const mx = Math.trunc(move.dx), my = Math.trunc(move.dy)
      if (mx || my) {
        out({ type: 'pointer', phase: 'move', dx: mx, dy: my })
        move = { dx: move.dx - mx, dy: move.dy - my }
      }
      const wx = Math.trunc(wheel.dx), wy = Math.trunc(wheel.dy)
      if (wx || wy) {
        out({ type: 'pointer', phase: 'wheel', dx: wx, dy: wy })
        wheel = { dx: wheel.dx - wx, dy: wheel.dy - wy }
      }
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(flush)
    }
    const click = (button: Button) => {
      out({ type: 'pointer', phase: 'down', button })
      out({ type: 'pointer', phase: 'up', button })
    }
    const isLocked = () => document.pointerLockElement === el
    // crossing this screen crosses the TV's (its pixels; the OS already accelerates the mouse)
    const mouseGain = () => {
      const tv = latest.current.screen?.width
      return tv ? Math.max(1, Math.min(3, tv / window.screen.width)) : 1
    }

    // ── the mouse: captured, then everything goes to the TV ──
    const mouseDown = (e: MouseEvent) => {
      e.preventDefault()
      if (!isLocked()) {
        if (e.button === 0 && latest.current.enabled) {
          // unadjustedMovement isn't everywhere: the plain request then
          el.requestPointerLock?.()?.catch?.(() => undefined)
        }
        return
      }
      const button = MOUSE_BUTTONS[e.button]
      if (!button) return
      flush()
      buttons.add(button)
      out({ type: 'pointer', phase: 'down', button })
    }
    const mouseUp = (e: MouseEvent) => {
      if (!isLocked()) return
      const button = MOUSE_BUTTONS[e.button]
      if (!button || !buttons.delete(button)) return
      flush()
      out({ type: 'pointer', phase: 'up', button })
    }
    const mouseMove = (e: MouseEvent) => {
      if (!isLocked()) return
      const g = mouseGain()
      move.dx += e.movementX * g
      move.dy += e.movementY * g
      schedule()
    }
    const key = (e: KeyboardEvent) => {
      // Esc releases the pointer (the browser's), so it never reaches the TV
      if (!isLocked() || e.isComposing || e.key === 'Escape') return
      e.preventDefault()
      const phase = e.type === 'keydown' ? 'down' : 'up'
      if (phase === 'down') keys.set(e.key, e.code)
      else if (!keys.delete(e.key)) return
      out({ type: 'key', phase, key: e.key, code: e.code || undefined, modifiers: modifiersOf(e), repeat: e.repeat || undefined })
    }
    const releaseAll = () => {
      flush()
      buttons.forEach((button) => out({ type: 'pointer', phase: 'up', button }))
      buttons.clear()
      keys.forEach((code, k) => out({ type: 'key', phase: 'up', key: k, code }))
      keys.clear()
    }
    const lockChange = () => {
      const now = isLocked()
      setLocked(now)
      if (!now) releaseAll()
    }

    // ── touch and pen: gestures ──
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return
      e.preventDefault()
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        // a pointer the browser no longer tracks: the gesture still works without capture
      }
      fingers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp, startX: e.clientX, startY: e.clientY })
      if (!gesture) gesture = { start: e.timeStamp, moved: false, most: 0, done: false }
      gesture.most = Math.max(gesture.most, fingers.size)
      clearTimeout(longPress)
      if (fingers.size === 1) {
        longPress = setTimeout(() => {
          if (gesture && !gesture.moved && gesture.most === 1 && !gesture.done) {
            gesture.done = true
            navigator.vibrate?.(15)
            click('right')
          }
        }, LONG_MS)
      }
    }

    const moved = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return
      const f = fingers.get(e.pointerId)
      if (!f || !gesture) return
      const dx = e.clientX - f.x, dy = e.clientY - f.y
      const ms = e.timeStamp - f.t
      f.x = e.clientX
      f.y = e.clientY
      f.t = e.timeStamp
      if (!gesture.moved && Math.hypot(e.clientX - f.startX, e.clientY - f.startY) > SLOP) {
        gesture.moved = true
        clearTimeout(longPress)
      }
      if (!gesture.moved || gesture.done) return
      if (fingers.size >= 2) {
        // two fingers scroll the page under the TV's pointer, the content following the fingers;
        // each finger adds half of the move
        wheel.dx -= (dx * 2) / fingers.size
        wheel.dy -= (dy * 2) / fingers.size
      } else if (gesture.most === 1) {
        const g = gain(Math.hypot(dx, dy), ms)
        move.dx += dx * g
        move.dy += dy * g
      }
      schedule()
    }

    const up = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return
      if (!fingers.delete(e.pointerId) || !gesture) return
      if (fingers.size > 0) return
      clearTimeout(longPress)
      const g = gesture
      gesture = null
      flush()
      if (g.done || g.moved || e.type === 'pointercancel') return
      const quick = e.timeStamp - g.start < (g.most >= 2 ? TAP_MS + 150 : TAP_MS)
      if (!quick) return
      navigator.vibrate?.(6)
      click(g.most >= 2 ? 'right' : 'left')
    }

    const wheeled = (e: WheelEvent) => {
      e.preventDefault()
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
      wheel.dx += e.deltaX * k
      wheel.dy += e.deltaY * k
      schedule()
    }
    const menu = (e: Event) => e.preventDefault()

    el.addEventListener('mousedown', mouseDown)
    document.addEventListener('mouseup', mouseUp)
    document.addEventListener('mousemove', mouseMove)
    window.addEventListener('keydown', key)
    window.addEventListener('keyup', key)
    document.addEventListener('pointerlockchange', lockChange)
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', moved)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    el.addEventListener('wheel', wheeled, { passive: false })
    el.addEventListener('contextmenu', menu)
    return () => {
      clearTimeout(longPress)
      cancelAnimationFrame(frame)
      if (isLocked()) document.exitPointerLock()
      releaseAll()
      el.removeEventListener('mousedown', mouseDown)
      document.removeEventListener('mouseup', mouseUp)
      document.removeEventListener('mousemove', mouseMove)
      window.removeEventListener('keydown', key)
      window.removeEventListener('keyup', key)
      document.removeEventListener('pointerlockchange', lockChange)
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', moved)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      el.removeEventListener('wheel', wheeled)
      el.removeEventListener('contextmenu', menu)
    }
  }, [])

  const aspect = screen?.width && screen?.height ? `${screen.width} / ${screen.height}` : '16 / 9'
  return (
    <div
      ref={pad}
      role="application"
      aria-label={`Touchpad for ${name}: drag to move its pointer, tap to click, long press or two-finger tap to go back, two-finger drag to scroll. With a mouse: click to control ${name}, Esc to stop.`}
      style={fill ? undefined : { aspectRatio: aspect }}
      className={cn(
        'group/pad relative w-full touch-none select-none overflow-hidden rounded-3xl bg-muted ring-gold transition-shadow',
        // the faint grid of a trackpad's surface
        'bg-[radial-gradient(circle,var(--color-border)_1px,transparent_1.5px)] bg-size-[22px_22px]',
        fill && 'h-full',
        locked ? 'cursor-none ring-2' : enabled ? 'cursor-pointer' : 'pointer-events-none opacity-50',
        className,
      )}
    >
      {/* where the TV's pointer is, on this miniature of its screen */}
      <div
        ref={dot}
        aria-hidden
        className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gold opacity-0 shadow-[0_0_0_4px_color-mix(in_oklab,var(--color-gold)_25%,transparent)] transition-opacity"
        style={{ left: '50%', top: '50%' }}
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-4 text-center text-sm text-muted-foreground">
        {locked ? (
          <p>
            Your mouse and keys are on {name}. <kbd className="rounded border bg-background px-1.5 text-xs">Esc</kbd> gives them back.
          </p>
        ) : (
          <>
            {/* phones and tablets */}
            <p className="pointer-fine:hidden">Drag to move, tap to click. Long press goes back, two fingers scroll.</p>
            <p className="hidden items-center gap-2 pointer-fine:flex">
              <MousePointer2 className="size-4" /> Click here to control {name} with your mouse and keyboard
            </p>
          </>
        )}
      </div>
    </div>
  )
}
