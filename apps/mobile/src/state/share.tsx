import { useEffect } from 'react'
import { router } from 'expo-router'
import { useQuery } from '@tanstack/react-query'
import { PlaybackSession } from '../core/playback/session'
import { inspectLink, linkSource, looseTitle, normalizeLink, type LinkItem } from '../core/services/search'
import { onShare, setShareTargets, takeShared, type Shared } from '../native/share'
import { castShared, pickFor, playsHere, screenOfShortcut, sharedLink, shortcutOf } from '../core/services/share'
import { getSettings } from '../core/services/settings'
import { Store } from '../core/util/store'
import { useApp, useCaster, useClient, useProfile, useSessionState } from './app'
import { useCast } from './cast'
import { openShare, pushPlayer } from './navigation'
import { useStore } from './hooks'
import { useToast } from '../ui/toast'

// Share to Playpex (docs/cast-plan.md §5): the text another app shared, from
// the intent that opened the app or one that comes while it runs
// (modules/playpex-device), kept until someone is watching (a server and a
// profile: the routes before that don't show it). Through a screen's direct
// share target, or with this phone's `cast.shareTo` set, it plays on that
// screen at once; else (or when that screen is off, or takes none of it) the
// /share sheet asks. The direct share targets follow the screens that are on.

const pending = new Store<(Shared & { at: number }) | null>(null)

function received(shared: Shared | null): void {
  if (shared) pending.set({ ...shared, at: Date.now() })
}

/** Mounted once, in the root layout */
export function ShareReceiver() {
  const state = useSessionState()
  const client = state.kind === 'connected' ? state.client : null
  const profileId = state.kind === 'connected' ? (state.profile?.id ?? null) : null
  const share = useStore(pending)
  const toast = useToast()
  const caster = useCaster()
  const { queryClient } = useApp()
  const { state: cast } = useCast()

  // the app's own intent once, then every share while it runs
  useEffect(() => {
    received(takeShared())
    return onShare(received)
  }, [])

  // the Share sheet's top row: one target per screen that's on
  const targets = cast.screens.filter((s) => s.accepts.media || s.accepts.embed).map((s) => ({ id: shortcutOf(s.deviceId), label: s.name }))
  const targetsKey = JSON.stringify(targets)
  useEffect(() => {
    if (cast.loaded) setShareTargets(JSON.parse(targetsKey))
  }, [targetsKey, cast.loaded])

  useEffect(() => {
    if (!share || !client || !profileId) return
    pending.set(null)
    const link = sharedLink(share.text)
    if (!link) {
      toast('Playpex can’t play this: there’s no link in it', { tone: 'error' })
      return
    }
    void (async () => {
      const wanted = screenOfShortcut(share.shortcut) ?? ((await getSettings(client, profileId).catch(() => null))?.device['cast.shareTo'] as string | null | undefined) ?? null
      if (!wanted || !caster) return openShare(link)
      const screen = (await caster.refresh()).find((s) => s.deviceId === wanted)
      if (!screen) {
        toast('That screen isn’t on: choose where to play it')
        return openShare(link)
      }
      try {
        const found = await queryClient.fetchQuery({ queryKey: ['share', profileId, link], queryFn: () => inspectLink(client, normalizeLink(link), profileId), staleTime: 5 * 60_000 })
        const item = pickFor(found.items, screen)
        if (!item) return openShare(link)
        await castShared(caster, item, screen, profileId)
        toast(`Playing on ${screen.name}`, { source: item.label })
      } catch (e) {
        toast((e as Error).message || 'Couldn’t play it', { tone: 'error' })
        openShare(link)
      }
    })()
  }, [share, client, profileId, caster, queryClient, toast])

  return null
}

/** What the server found in a shared link (POST /links/inspect, as the profile: refused for kids) */
export function useSharedLink(link: string) {
  const client = useClient()
  const profile = useProfile()
  return useQuery({ queryKey: ['share', profile.id, link], queryFn: () => inspectLink(client, normalizeLink(link), profile.id), staleTime: 5 * 60_000, retry: false })
}

/** Plays a found item: on a screen (cast), or on this phone (nothing saved: it's no title of the catalog) */
export function usePlayShared(): (item: LinkItem, where: { deviceId: string; name: string } | null) => Promise<void> {
  const client = useClient()
  const profile = useProfile()
  const caster = useCaster()
  const { playbacks } = useApp()
  return async (item, where) => {
    if (where) {
      if (!caster) throw new Error('Not connected')
      await castShared(caster, item, where, profile.id)
      return
    }
    if (!playsHere(item)) throw new Error('This phone can’t play it: choose a screen')
    const session = new PlaybackSession({ client, profileId: profile.id, title: looseTitle(item.label), source: linkSource(item), startAt: 0, tracking: 'none' })
    // the share screen gives way to the player
    router.back()
    pushPlayer(playbacks.add(session), { here: true })
  }
}
