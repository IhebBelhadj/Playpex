import { useCallback } from 'react'
import { useNavigate } from 'react-router'
import { refFormat, useCastTarget, useCastTo, watchAsProfile } from './cast'

// Playing opens the player's own page (pages/watch.tsx): /watch/<ref> with
// what it shows (the title, a line under it) and where the file lives, so
// "Add subtitles › From the server" starts in its folder. A reload plays it again.
// While a screen is chosen in the top bar's cast button (lib/cast.ts), Play
// sends it there instead (as the player's "Watch as" profile, else the screen's own).

export type PlayItem = {
  ref: string
  title: string
  /** a line under the title: the torrent, the folder */
  detail?: string
  /** the Library place holding the file (`folder:<id>`, `downloads`) and its folder there */
  place?: string
  dir?: string
}

export function watchUrl(item: PlayItem): string {
  const q = new URLSearchParams({ title: item.title })
  if (item.detail) q.set('detail', item.detail)
  if (item.place) q.set('place', item.place)
  if (item.dir) q.set('dir', item.dir)
  return `/watch/${encodeURIComponent(item.ref)}?${q}`
}

export function usePlayer() {
  const navigate = useNavigate()
  const target = useCastTarget()
  const castTo = useCastTo()
  const play = useCallback(
    (item: PlayItem, opts?: { here?: boolean }) => {
      if (target && !opts?.here) {
        castTo.mutate({
          screen: target,
          request: {
            title: item.title,
            subtitle: item.detail,
            source: { ref: item.ref, format: refFormat(item.ref) },
            profileId: watchAsProfile(),
          },
        })
        return
      }
      navigate(watchUrl(item))
    },
    [navigate, target, castTo],
  )
  return { play, target }
}

/** A library file's place and folder, for PlayItem */
export function placeOf(folderId: string, relPath: string): { place: string; dir: string } {
  return { place: `folder:${folderId}`, dir: relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '' }
}
