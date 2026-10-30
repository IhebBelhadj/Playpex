// Playpex Mobile's look: "the lights go down". The app is a dark auditorium,
// warm rather than neutral; each title lights the room with its own picture
// (Ambient), and the one fixed colour is the champagne of the Playpex mark.
// Components take colours, type and lengths from here, never as literals.

const palette = {
  auditorium: '#100D0B',
  seat: '#1C1713',
  aisle: '#2A231E',
  curtain: '#3A312A',
  screen: '#F3EEE6',
  usher: '#A39A8F',
  champagne: '#E6CF8F',
  champagneBright: '#F6E084',
  champagneDeep: '#C9A961',
  green: '#6FD08C',
  orange: '#F0A44B',
  red: '#E5484D',
  redLight: '#FF7A7A',
  black: '#000',
}

export const color = {
  bg: palette.auditorium,
  text: palette.screen,
  textSoft: 'rgba(243, 238, 230, .88)',
  textSecondary: 'rgba(243, 238, 230, .72)',
  textMuted: palette.usher,
  textDim: 'rgba(243, 238, 230, .45)',
  /** The mark's gold: Play, progress, what is chosen */
  accent: palette.champagne,
  accentBright: palette.champagneBright,
  accentDeep: palette.champagneDeep,
  /** The gold seen through the dark: a Top 10's numerals */
  accentGhost: 'rgba(230, 207, 143, .26)',
  onAccent: palette.auditorium,
  focus: palette.screen,
  onFocus: palette.auditorium,
  /** Secondary text on a white (focused) surface: the timeline's scrub tab */
  onFocusMuted: 'rgba(16, 13, 11, .6)',
  progress: palette.champagne,
  progressTrack: 'rgba(243, 238, 230, .18)',
  /** The timeline: what the player holds in memory, and what a torrent has downloaded of the file */
  buffered: 'rgba(243, 238, 230, .42)',
  downloaded: 'rgba(243, 238, 230, .22)',
  live: palette.green,
  caution: palette.orange,
  danger: palette.red,
  error: palette.redLight,
  line: 'rgba(243, 238, 230, .12)',
  lineStrong: 'rgba(243, 238, 230, .24)',
  surface1: 'rgba(243, 238, 230, .07)',
  surface2: palette.seat,
  surface3: palette.aisle,
  surface4: palette.curtain,
  raised: 'rgba(28, 23, 19, .94)',
  glass: 'rgba(16, 13, 11, .72)',
  /** Bars over scrolling pictures (the tab bar, page headers): nearly opaque, so labels stay readable */
  bar: 'rgba(16, 13, 11, .94)',
  scrim: 'rgba(0, 0, 0, .55)',
  black: palette.black,
  /** IMDb's own yellow, for its mark beside its rating */
  imdb: '#F5C518',
  placeholder: palette.seat,
  outline: palette.usher,
  transparent: 'rgba(16, 13, 11, 0)',
  /** The page's black at two strengths, for the darkness the chrome sits on */
  dark75: 'rgba(16, 13, 11, .75)',
  dark86: 'rgba(16, 13, 11, .86)',
  /** The aisle light's glow under the gold line of the tab you are in (ui/chrome.tsx) */
  lightGlow: 'rgba(230, 207, 143, .16)',
  transparentGold: 'rgba(230, 207, 143, 0)',
  /** Settings' subtitle preview: a night at sea, and the player's white subtitles */
  stillSky: '#1D2A33',
  stillSea: '#13202A',
  subtitle: '#FFFFFF',
}

/** Each avatar's own colour (its SVG's ground, assets/avatars): drawn under the face, so a morphing avatar is never blank */
export const avatarColor: Record<string, string> = {
  'avatar-01': '#2D7FF9',
  'avatar-02': '#F5C518',
  'avatar-03': '#E5383B',
  'avatar-04': '#2BB673',
  'avatar-05': '#8E5CF7',
  'avatar-06': '#F57C00',
  'avatar-07': '#14B8A6',
  'avatar-08': '#EC4899',
  'avatar-09': '#64748B',
  'avatar-10': '#84CC16',
  'avatar-11': '#4F46E5',
  'avatar-12': '#C2410C',
}

/** The room's darkness laid over a picture, from clear to the page's colour */
export const fade = {
  toBg: [color.transparent, 'rgba(16, 13, 11, .55)', color.bg] as const,
  /** A picture melting into the page, its darkness eased in over the lower 80 % so no line shows where it ends
   *  (even stops: expo-linear-gradient's `locations` didn't draw on Android) */
  melt: [color.transparent, color.transparent, color.transparent, 'rgba(16, 13, 11, 0.03)', 'rgba(16, 13, 11, 0.1)', 'rgba(16, 13, 11, 0.2)', 'rgba(16, 13, 11, 0.31)', 'rgba(16, 13, 11, 0.43)', 'rgba(16, 13, 11, 0.56)', 'rgba(16, 13, 11, 0.7)', 'rgba(16, 13, 11, 0.85)', color.bg] as const,
  top: ['rgba(16, 13, 11, .7)', color.transparent] as const,
  ambient: ['rgba(16, 13, 11, .35)', 'rgba(16, 13, 11, .82)', color.bg] as const,
  /** The player's controls over the picture, as on the TV: clear above, black at the bottom (even stops) */
  player: ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0.08)', 'rgba(0, 0, 0, 0.3)', 'rgba(0, 0, 0, 0.6)', 'rgba(0, 0, 0, 0.82)', palette.black] as const,
  /** The top of the picture, under the Back button */
  playerTop: ['rgba(0, 0, 0, 0.55)', 'rgba(0, 0, 0, 0)'] as const,
}

export const space = { xxs: 2, xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32, xxxl: 48 }

/** Corners by size: small things round a little, large pictures barely */
export const radius = { s: 6, m: 10, l: 14, xl: 20, pill: 999 }

/** Families embedded by expo-font (app.json); Android names them by file */
export const font = {
  display: 'Futura-Bold',
  displayBook: 'Futura-Book',
  body: 'HankenGrotesk-Regular',
  medium: 'HankenGrotesk-Medium',
  semibold: 'HankenGrotesk-SemiBold',
}

// The scale: 12 · 14 · 16 · 20 · 26 · 34 · 44 (about 1.27 apart). Display
// sizes are Futura, tight; reading sizes are Hanken Grotesk, open.
export const text = {
  marquee: { fontFamily: font.display, fontSize: 44, lineHeight: 46, letterSpacing: -0.8, color: color.text },
  hero: { fontFamily: font.display, fontSize: 34, lineHeight: 38, letterSpacing: -0.5, color: color.text },
  title: { fontFamily: font.display, fontSize: 26, lineHeight: 30, letterSpacing: -0.3, color: color.text },
  heading: { fontFamily: font.display, fontSize: 20, lineHeight: 24, letterSpacing: -0.2, color: color.text },
  label: { fontFamily: font.semibold, fontSize: 16, lineHeight: 20, color: color.text },
  body: { fontFamily: font.body, fontSize: 16, lineHeight: 24, color: color.textSoft },
  small: { fontFamily: font.medium, fontSize: 14, lineHeight: 19, color: color.textMuted },
  tiny: { fontFamily: font.medium, fontSize: 12, lineHeight: 16, color: color.textDim },
}

export const motion = {
  /** A press: things give a little under the finger */
  pressScale: 0.96,
  fast: 160,
  base: 260,
  slow: 420,
}
