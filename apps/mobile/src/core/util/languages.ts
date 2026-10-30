// The languages people choose from (ISO 639-1): the catalogue's original
// language filter, the profile's audio and subtitle languages. The commonest
// first; anything else stays valid on the server, shown by its code.

export const LANGUAGES: { code: string; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'French' },
  { code: 'es', name: 'Spanish' },
  { code: 'ar', name: 'Arabic' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh', name: 'Chinese' },
  { code: 'hi', name: 'Hindi' },
  { code: 'tr', name: 'Turkish' },
  { code: 'ru', name: 'Russian' },
  { code: 'nl', name: 'Dutch' },
  { code: 'sv', name: 'Swedish' },
  { code: 'da', name: 'Danish' },
  { code: 'no', name: 'Norwegian' },
  { code: 'pl', name: 'Polish' },
  { code: 'th', name: 'Thai' },
]

export function languageName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code.toUpperCase()
}

/** The ISO 639-2 codes files tag their tracks with (both forms where they differ) */
const THREE: Record<string, string[]> = {
  en: ['eng'], fr: ['fre', 'fra'], es: ['spa'], ar: ['ara'], de: ['ger', 'deu'], it: ['ita'], pt: ['por'], ja: ['jpn'], ko: ['kor'],
  zh: ['chi', 'zho'], hi: ['hin'], tr: ['tur'], ru: ['rus'], nl: ['dut', 'nld'], sv: ['swe'], da: ['dan'], no: ['nor', 'nob'], pl: ['pol'], th: ['tha'],
}

/** A language as a track-matching list ("fr,fre,fra"), for the player */
export function trackLanguages(code: string): string {
  return [code, ...(THREE[code] ?? [])].join(',')
}
