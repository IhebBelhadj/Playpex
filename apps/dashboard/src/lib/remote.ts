import type { RemoteMessage, RemoteRtcMessage, RemoteSignal } from '@playpex/protocol'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, API_PREFIX, unwrap } from './api'

// The dashboard as a remote control (docs/remote-control-plan.md §2.5, §2.7):
// one controller socket to /api/v1/remote per open controller page.

export type RemoteState = Extract<RemoteMessage, { type: 'state' }>
/** What the controller sends (the target's input) */
export type RemoteInput = Extract<RemoteMessage, { type: 'key' | 'text' | 'pointer' | 'bye' }>

/** connecting: opening · open: the server answers (state.connected says whether the device is there) ·
 *  retrying: the socket dropped, opening again · taken / refused / ended: stopped, no retry */
export type RemotePhase = 'connecting' | 'open' | 'retrying' | 'taken' | 'refused' | 'ended'

export function useRemoteTargets() {
  return useQuery({
    queryKey: ['remote-targets'],
    queryFn: () => unwrap(api.GET('/remote/targets')),
    // remote.updated invalidates it (events.tsx); the interval covers a dropped events socket
    refetchInterval: 5000,
  })
}

type Pointer = Extract<RemoteInput, { type: 'pointer' }>

// Past this much waiting in the moves channel, moves are summed and sent later
const MOVES_BEHIND = 2048

/**
 * The pointer straight to a target that says `rtc` (docs/api/remote.md, "Over WebRTC"): this side
 * offers, the target answers, through `signal` messages on the socket. `moves` is unordered and never
 * resent and carries running totals (a lost one costs nothing: the next has the sum); `input` is
 * ordered and reliable (buttons, wheel, with the totals). The cursor comes back on `moves`. Until both
 * are open, or if they fail, `pointer()` says no and the socket carries everything.
 */
class DirectPointer {
  private pc: RTCPeerConnection
  private moves: RTCDataChannel
  private input: RTCDataChannel
  private seq = 0
  private x = 0
  private y = 0
  private later: ReturnType<typeof setTimeout> | undefined
  private onClose: () => void
  closed = false

  constructor(signal: (data: RemoteSignal) => void, onCursor: (x: number, y: number) => void, onClose: () => void) {
    this.onClose = onClose
    const pc = (this.pc = new RTCPeerConnection({ iceServers: [] }))
    this.moves = pc.createDataChannel('moves', { ordered: false, maxRetransmits: 0 })
    this.input = pc.createDataChannel('input', { ordered: true })
    this.moves.onmessage = (e) => {
      let msg: RemoteRtcMessage
      try {
        msg = JSON.parse(e.data as string)
      } catch {
        return
      }
      if (msg.t === 'cursor' && typeof msg.x === 'number' && typeof msg.y === 'number') onCursor(msg.x, msg.y)
    }
    this.moves.onclose = this.input.onclose = () => this.close()
    pc.onicecandidate = (e) => signal({ candidate: e.candidate ? (e.candidate.toJSON() as never) : null })
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.close()
    }
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        if (!this.closed && pc.localDescription) signal({ description: { type: 'offer', sdp: pc.localDescription.sdp } })
      })
      .catch(() => this.close())
  }

  get open() {
    return !this.closed && this.moves.readyState === 'open' && this.input.readyState === 'open'
  }

  handle(data: RemoteSignal) {
    if (this.closed) return
    if ('description' in data) {
      if (data.description.type === 'answer') this.pc.setRemoteDescription(data.description).catch(() => this.close())
    } else if ('candidate' in data) {
      this.pc.addIceCandidate(data.candidate ?? undefined).catch(() => undefined)
    }
  }

  /** Sends a pointer message this way: false when it can't (the socket's turn) */
  pointer(msg: Pointer): boolean {
    if (!this.open) return false
    if (msg.phase === 'move') {
      if (!('dx' in msg)) return false
      this.x += msg.dx
      this.y += msg.dy
      this.seq += 1
      this.sendMove()
      return true
    }
    // a button or the wheel: the moves so far go with it, so it lands where the pointer is
    const at = { s: this.seq, x: this.x, y: this.y }
    this.input.send(
      JSON.stringify(
        (msg.phase === 'wheel'
          ? { t: 'pointer', ...at, phase: 'wheel', dx: msg.dx, dy: msg.dy }
          : { t: 'pointer', ...at, phase: msg.phase, button: msg.button }) satisfies RemoteRtcMessage,
      ),
    )
    return true
  }

  private sendMove() {
    clearTimeout(this.later)
    if (!this.open) return
    // a congested link: these totals go with the next send (or a little later)
    if (this.moves.bufferedAmount > MOVES_BEHIND) {
      this.later = setTimeout(() => this.sendMove(), 16)
      return
    }
    this.moves.send(JSON.stringify({ t: 'move', s: this.seq, x: this.x, y: this.y } satisfies RemoteRtcMessage))
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.later)
    this.moves.onclose = this.input.onclose = null
    this.pc.onicecandidate = this.pc.onconnectionstatechange = null
    this.pc.close()
    this.onClose()
  }
}

/**
 * The controller socket for `deviceId`. Reconnects with back-off while mounted, unless another
 * admin took over (4001), the server refused (4003) or the control ended: `connect()` starts again
 * (and takes the device back). Says `bye` and closes on unmount. One hook per device: key its
 * component by `deviceId`.
 */
export function useRemote(deviceId: string, onCursor: (x: number, y: number) => void) {
  const [phase, setPhase] = useState<RemotePhase>('connecting')
  const [state, setState] = useState<RemoteState | null>(null)
  const socket = useRef<WebSocket | null>(null)
  const direct = useRef<DirectPointer | null>(null)
  /** the pointer goes straight to the device (WebRTC), not through the server */
  const [isDirect, setDirect] = useState(false)
  const cursor = useRef(onCursor)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    cursor.current = onCursor
  })

  useEffect(() => {
    let ws: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    let delay = 1000
    let done = false
    // one try per connection to the device: a failed one leaves the socket in charge
    let tried = false
    const stopDirect = () => {
      direct.current?.close()
      direct.current = null
      tried = false
    }

    const open = () => {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const url = `${scheme}//${location.host}${API_PREFIX}/remote?role=controller&device=${encodeURIComponent(deviceId)}`
      ws = new WebSocket(url)
      const own = ws
      socket.current = ws
      let stopped: RemotePhase | null = null
      ws.onopen = () => {
        delay = 1000
        setPhase('open')
      }
      ws.onmessage = (message) => {
        let msg: RemoteMessage
        try {
          msg = JSON.parse(message.data as string)
        } catch {
          return
        }
        if (msg.type === 'cursor') {
          cursor.current(msg.x, msg.y)
        } else if (msg.type === 'signal') {
          if (msg.data && typeof msg.data === 'object') direct.current?.handle(msg.data)
        } else if (msg.type === 'state') {
          setState(msg)
          if (!msg.connected) {
            stopDirect()
          } else if (msg.capabilities?.rtc && !tried && typeof RTCPeerConnection !== 'undefined') {
            tried = true
            const sendSignal = (data: RemoteSignal) => {
              if (own.readyState === WebSocket.OPEN) own.send(JSON.stringify({ type: 'signal', data } satisfies RemoteMessage))
            }
            const d: DirectPointer = new DirectPointer(sendSignal, (x, y) => cursor.current(x, y), () => {
              if (direct.current === d) {
                direct.current = null
                setDirect(false)
              }
            })
            direct.current = d
            // opened: say so (moves switch over at once, `pointer()` checks it)
            const watch = setInterval(() => {
              if (d.closed) clearInterval(watch)
              else if (d.open) {
                clearInterval(watch)
                if (direct.current === d) setDirect(true)
              }
            }, 100)
          }
          if (!msg.connected && (msg.reason === 'taken' || msg.reason === 'refused' || msg.reason === 'ended')) {
            stopped = msg.reason
          }
        }
      }
      ws.onclose = (event) => {
        if (socket.current === own) {
          socket.current = null
          stopDirect()
        }
        if (done) return
        const reason: RemotePhase | null =
          event.code === 4001 ? 'taken' : event.code === 4003 ? 'refused' : stopped ?? (event.code === 1000 ? 'ended' : null)
        if (reason) {
          setPhase(reason)
          return
        }
        setPhase('retrying')
        retry = setTimeout(open, delay)
        delay = Math.min(delay * 2, 15_000)
      }
    }
    open()
    return () => {
      done = true
      clearTimeout(retry)
      stopDirect()
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'bye' }))
      ws?.close(1000, 'bye')
      socket.current = null
    }
  }, [deviceId, attempt])

  const send = useCallback((msg: RemoteInput) => {
    if (msg.type === 'pointer' && direct.current?.pointer(msg)) return
    const ws = socket.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }, [])

  const connect = useCallback(() => {
    setPhase('connecting')
    setAttempt((n) => n + 1)
  }, [])

  return { phase, state, send, connect, live: phase === 'open' && !!state?.connected, direct: isDirect }
}

const MODIFIERS = [
  ['shiftKey', 'shift'],
  ['ctrlKey', 'control'],
  ['altKey', 'alt'],
  ['metaKey', 'meta'],
] as const

export function modifiersOf(e: KeyboardEvent) {
  return MODIFIERS.filter(([k]) => e[k]).map(([, m]) => m)
}
