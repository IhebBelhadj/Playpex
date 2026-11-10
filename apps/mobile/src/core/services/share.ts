import type { CastRequest } from '../cast/caster'
import type { LinkItem } from './search'

// Share to Playpex (docs/cast-plan.md §5): another app shares text (often
// "A title https://…" or a bare link); the link in it is read by the server
// (POST /links/inspect: YouTube videos, video files, HLS, magnets, a page's
// links), and what it found plays on a screen or on this phone.

const URL_IN_TEXT = /(https?:\/\/[^\s<>"']+|magnet:\?[^\s<>"']+)/i
const INFO_HASH = /\b[a-f0-9]{40}\b/i

/** The link in shared text, else null (a bare info hash counts) */
export function sharedLink(text: string): string | null {
  const t = String(text ?? '').trim()
  const url = URL_IN_TEXT.exec(t)
  if (url) return url[1].replace(/[),.;!?]+$/, '')
  const hash = INFO_HASH.exec(t)
  return hash ? hash[0].toLowerCase() : null
}

/** Whether this phone's player plays it (a YouTube video only plays on a screen) */
export function playsHere(item: LinkItem): boolean {
  return item.kind !== 'youtube'
}

/** What a found item is, in a few words */
export function itemLine(item: LinkItem): string {
  switch (item.kind) {
    case 'youtube':
      return ['YouTube', item.author].filter(Boolean).join(' · ')
    case 'video':
      return 'Video file'
    case 'hls':
      return 'Stream'
    case 'torrent':
      return 'Torrent file'
    case 'magnet':
      return 'Torrent'
    default:
      return item.kind
  }
}

/** The cast of a YouTube item: the core's embed page plays it on the screen, from the link's `t=` */
export function embedRequest(item: LinkItem, profileId: string | null): CastRequest | null {
  if (item.kind !== 'youtube' || !item.embed) return null
  return {
    title: item.label,
    ...(item.author ? { subtitle: item.author } : {}),
    ...(item.image ? { image: item.image } : {}),
    source: { embed: { provider: 'youtube', id: item.embed.id } },
    ...(item.startS ? { positionS: Math.floor(item.startS) } : {}),
    ...(profileId ? { profileId } : {}),
    // a video from a link is no title of the catalog: nothing saved for it
    tracking: 'none',
  }
}
