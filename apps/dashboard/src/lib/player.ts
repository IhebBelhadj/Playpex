import { useCallback } from 'react'
import { useNavigate } from 'react-router'

// Playing opens the player's own page (pages/watch.tsx): /watch/<ref> with
// what it shows (the title, a line under it) and where the file lives, so
// "Add subtitles › From the server" starts in its folder. A reload plays it again.

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
  const play = useCallback((item: PlayItem) => navigate(watchUrl(item)), [navigate])
  return { play }
}

/** A library file's place and folder, for PlayItem */
export function placeOf(folderId: string, relPath: string): { place: string; dir: string } {
  return { place: `folder:${folderId}`, dir: relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '' }
}
