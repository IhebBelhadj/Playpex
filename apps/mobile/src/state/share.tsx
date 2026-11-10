import { useEffect } from 'react'
import { router } from 'expo-router'
import { useQuery } from '@tanstack/react-query'
import { PlaybackSession } from '../core/playback/session'
import { inspectLink, linkSource, looseTitle, normalizeLink, type LinkItem } from '../core/services/search'
import { onShare, takeSharedText } from '../native/share'
import { embedRequest, playsHere, sharedLink } from '../core/services/share'
import { Store } from '../core/util/store'
import { useApp, useCaster, useClient, useProfile, useSessionState } from './app'
import { openShare, pushPlayer } from './navigation'
import { useStore } from './hooks'
import { useToast } from '../ui/toast'

// Share to Playpex (docs/cast-plan.md §5): the text another app shared, from
// the intent that opened the app or one that comes while it runs
// (modules/playpex-device), kept until someone is watching (a server and a
// profile: the routes before that don't show it), then opened in /share.

const pending = new Store<{ text: string; at: number } | null>(null)

function received(text: string | null): void {
  if (text) pending.set({ text, at: Date.now() })
}

/** Mounted once, in the root layout */
export function ShareReceiver() {
  const state = useSessionState()
  const watching = state.kind === 'connected' && state.profile != null
  const share = useStore(pending)
  const toast = useToast()

  // the app's own intent once, then every share while it runs
  useEffect(() => {
    received(takeSharedText())
    return onShare(received)
  }, [])

  useEffect(() => {
    if (!share || !watching) return
    pending.set(null)
    const link = sharedLink(share.text)
    if (!link) {
      toast('Playpex can’t play this: there’s no link in it', { tone: 'error' })
      return
    }
    openShare(link)
  }, [share, watching, toast])

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
      const embed = embedRequest(item, profile.id)
      if (embed) await caster.send(embed, null, where)
      else await caster.play({ title: looseTitle(item.label), source: linkSource(item), tracking: 'none' }, { profileId: profile.id, screen: where })
      return
    }
    if (!playsHere(item)) throw new Error('This phone can’t play it: choose a screen')
    const session = new PlaybackSession({ client, profileId: profile.id, title: looseTitle(item.label), source: linkSource(item), startAt: 0, tracking: 'none' })
    // the share screen gives way to the player
    router.back()
    pushPlayer(playbacks.add(session), { here: true })
  }
}
