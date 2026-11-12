import { useEffect } from 'react'
import { Caster, type CasterState, type Casted } from '../core/cast/caster'
import { PlaybackSession } from '../core/playback/session'
import { Store } from '../core/util/store'
import { useApp, useCaster, useSessionState } from './app'
import { useStore } from './hooks'
import { pushPlayer, setCastHandoff } from './navigation'
import { useToast } from '../ui/toast'

// Casting for the screens (core/cast/caster.ts): its state, the hand-off that
// sends Play to the chosen screen, and Continue on phone.

// The top bar's "Play on" sheet: opened by its button, drawn at the root (features/cast CastBar), since
// a sheet inside the top bar's own box would be clipped to it
const picker = new Store<boolean>(false)
export function openCastPicker(): void {
  picker.set(true)
}
export function closeCastPicker(): void {
  picker.set(false)
}
export function useCastPickerOpen(): boolean {
  return useStore(picker)
}

const EMPTY = new Store<CasterState>({ screens: [], loaded: false, target: null, cast: null, casted: null, sending: false })

/** The caster's state (an empty one before a server is connected) */
export function useCast(): { caster: Caster | null; state: CasterState } {
  const caster = useCaster()
  const state = useStore(caster?.state ?? EMPTY)
  return { caster, state }
}

/**
 * While a screen is chosen and on, the sessions made for the player go there instead
 * (state/navigation.ts): the session is taken from the registry and never started.
 * Mounted once, in the root layout.
 */
export function CastHandoff() {
  const caster = useCaster()
  const { playbacks } = useApp()
  const session = useSessionState()
  const profileId = session.kind === 'connected' ? (session.profile?.id ?? null) : null
  const toast = useToast()
  useEffect(() => {
    if (!caster) return
    setCastHandoff((sessionId) => {
      const target = caster.targetOnline()
      if (!target) return false
      const taken = playbacks.take(sessionId)
      if (!taken) return false
      const what: Casted = { title: taken.title, source: taken.source, tracking: taken.tracking }
      caster.play(what, { positionS: taken.startAt, profileId }).then(
        () => toast(`Playing on ${target.name}`, { source: taken.label }),
        (e: Error) => toast(e.message || `Couldn’t play on ${target.name}`, { tone: 'error' }),
      )
      return true
    })
    return () => setCastHandoff(null)
  }, [caster, playbacks, profileId, toast])
  return null
}

/** Continue on phone: the cast stops, this phone's player opens where it was */
export function useContinueOnPhone(): () => Promise<void> {
  const { caster } = useCast()
  const { playbacks, session } = useApp()
  const toast = useToast()
  return async () => {
    if (!caster) return
    const back = await caster.takeBack()
    const state = session.state.get()
    if (!back || state.kind !== 'connected' || !state.profile) return
    const playing = new PlaybackSession({
      client: state.client,
      profileId: state.profile.id,
      title: back.casted.title,
      source: back.casted.source,
      startAt: back.positionS,
      tracking: back.casted.tracking,
    })
    pushPlayer(playbacks.add(playing), { here: true })
    toast('Playing on this phone')
  }
}
