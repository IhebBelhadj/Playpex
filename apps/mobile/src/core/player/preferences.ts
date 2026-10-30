import { trackLanguages } from '../util/languages'

// What the profile's settings and this phone's (Settings) ask of the player,
// as mpv properties set before a file opens: the audio and subtitle tracks it
// starts with, and the subtitles' size. Tracks chosen in the player for this
// release (kept with the resume point) still win afterwards.

export type PlayerPreferences = {
  /** 'original' or an ISO 639-1 code */
  audioLanguage: string
  /** 'off' or an ISO 639-1 code */
  subtitleLanguage: string
  subtitleForcedOnly: boolean
  subtitleSize: 'small' | 'medium' | 'large' | 'largest'
}

export const SUBTITLE_SCALE: Record<PlayerPreferences['subtitleSize'], number> = { small: 0.8, medium: 1, large: 1.25, largest: 1.5 }

export function playerProperties(p: PlayerPreferences): [string, string][] {
  const properties: [string, string][] = [['sub-scale', String(SUBTITLE_SCALE[p.subtitleSize] ?? 1)]]
  // The release's own audio: the file's default track, whatever its language
  properties.push(['alang', p.audioLanguage === 'original' ? '' : trackLanguages(p.audioLanguage)])
  if (p.subtitleLanguage === 'off') {
    properties.push(['slang', ''], ['sid', 'no'])
  } else if (p.subtitleForcedOnly) {
    // Only the lines in another language: the forced track of that language, nothing when there's none
    properties.push(['slang', trackLanguages(p.subtitleLanguage)], ['subs-fallback', 'no'], ['subs-fallback-forced', 'always'], ['sid', 'auto'])
  } else {
    properties.push(['slang', trackLanguages(p.subtitleLanguage)], ['sid', 'auto'])
  }
  return properties
}
