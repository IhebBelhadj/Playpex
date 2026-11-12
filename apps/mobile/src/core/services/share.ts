import type { Caster, CastRequest, CastScreen } from '../cast/caster'
import { linkSource, looseTitle, type LinkItem } from './search'

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

// ── straight to a screen (a direct share target, or the phone's cast.shareTo) ──

const SHORTCUT = 'screen:'

/** The direct share target of a screen (modules/playpex-device setShareTargets) */
export function shortcutOf(deviceId: string): string {
  return SHORTCUT + deviceId
}

/** The screen a direct share target stands for, else null */
export function screenOfShortcut(id: string | null | undefined): string | null {
  return id && id.startsWith(SHORTCUT) ? id.slice(SHORTCUT.length) || null : null
}

/** Whether a screen plays this kind of item */
export function takes(screen: CastScreen, item: LinkItem): boolean {
  if (item.kind === 'youtube') return screen.accepts.embed
  if (item.kind === 'magnet' || item.kind === 'torrent') return screen.accepts.magnet
  return screen.accepts.media
}

/** What a shared link plays on that screen without asking: its one thing, or a page's first the screen takes */
export function pickFor(items: LinkItem[], screen: CastScreen): LinkItem | null {
  return items.find((i) => takes(screen, i)) ?? null
}

/** Casts a found item to a screen: a YouTube video as the core embed, anything else as a source; nothing saved */
export function castShared(caster: Caster, item: LinkItem, screen: { deviceId: string; name: string }, profileId: string | null): Promise<string> {
  const embed = embedRequest(item, profileId)
  return embed
    ? caster.send(embed, null, screen)
    : caster.play({ title: looseTitle(item.label), source: linkSource(item), tracking: 'none' }, { profileId, screen })
}
