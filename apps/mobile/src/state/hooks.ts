import { useEffect, useEffectEvent, useState, useSyncExternalStore } from 'react'
import { BackHandler } from 'react-native'
import { router } from 'expo-router'
import type { Store } from '../core/util/store'

// The bridges between core's objects and React. They are the only effects the
// app's screens rely on: features and ui have none of their own (eslint).

/** A store's value; the component renders again when it changes */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

/**
 * One field of a store, for components that need only part of it. `select`
 * must return a primitive or a value already in the store (never a new object
 * or array: useSyncExternalStore would see a change on every read).
 */
export function useStoreField<T, U>(store: Store<T>, select: (value: T) => U): U {
  const read = () => select(store.get())
  return useSyncExternalStore(store.subscribe, read, read)
}

/**
 * What a controller is to the screen that owns it: started when the screen
 * mounts, stopped when it goes. start() after stop() must work (a development
 * double mount does exactly that), and both must be safe to call twice.
 */
export type Owned = { start(): void; stop(): void }

/** A controller made once for this screen, running while the screen is mounted */
export function useOwned<T extends Owned>(create: () => T): T {
  const [owned] = useState(create)
  useEffect(() => {
    owned.start()
    return () => owned.stop()
  }, [owned])
  return owned
}

/** Runs a controller made elsewhere (a playback session from the registry) while this screen is mounted */
export function useRunning(owned: Owned | null | undefined): void {
  useEffect(() => {
    if (!owned) return
    owned.start()
    return () => owned.stop()
  }, [owned])
}

/** `value`, once it has stayed the same for `ms` (a search field) */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

/** The time, again every `ms` while the component is mounted (a countdown) */
export function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

/** Android's Back calls `onBack` while `active` (an open sheet closes instead of the screen) */
export function useBackPress(active: boolean, onBack: () => void): void {
  const back = useEffectEvent(onBack)
  useEffect(() => {
    if (!active) return
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      back()
      return true
    })
    return () => sub.remove()
  }, [active])
}

/**
 * Back from a screen whose pictures morphed in (a title, Settings). Its morph
 * tags go first (`leaving`: pass `tag={leaving ? undefined : tag}`), then the
 * screen pops once that render is committed: Reanimated's reverse morph on a
 * pop can leave the poster it flies to hidden for good, so Back is a fade and
 * the poster that opened the screen is simply shown again. Android's Back too.
 */
export function useLeave(): { leaving: boolean; leave: () => void } {
  const [leaving, setLeaving] = useState(false)
  const canLeave = router.canGoBack()
  useEffect(() => {
    if (leaving) router.back()
  }, [leaving])
  useBackPress(canLeave && !leaving, () => setLeaving(true))
  return { leaving, leave: () => (canLeave ? setLeaving(true) : router.back()) }
}
