'use strict';

// Release names (docs/providers-plan.md §4.1, §4.2): what the core knows about
// a torrent's or a file's name, in one place for the play pipeline, the
// downloads, the release lists, the library and plugins (`playpex.names.*`).
//
//   parse(name)               { title, year, season, episode, episodeEnd, pack,
//                               resolution, source, codec, audio, hdr }
//   describe(name)            { quality, codec, audio, playable }: what Electron's Chromium plays
//   release(name, kind)       { title, year (+ season, episode, pack for 'tv') }: a release list's line
//   matchKind(name, title, s, e)   'episode' | 'pack' | null: the strict matcher ("Breaking Brad")
//   matches(name, titleRef)   that, for a plugin's titleRef (a movie: 'movie' | null)
//   compare(a, b) / rank(list)     the streaming order
//   searchWords(text)         keywords as sites read them ("Breaking.Bad" → "Breaking Bad")
//   searchMatches(name, text) whether a release name holds every keyword, however it's spelt
//
// Streaming in Chromium: H.264 plays everywhere; HEVC / x265, 10-bit, XviD
// and 4K often don't, or are too large to stream smoothly. Audio: AAC / Opus /
// MP3 decode, Dolby (AC-3, E-AC-3 / DDP, TrueHD) and DTS don't (they play
// silently, or through the server's ffmpeg).

var parseFile = require('../library/parse');

// Seeders needed before a torrent counts as fast enough to stream
var HEALTHY_SEEDS = 10;

var RESOLUTION_RANK = { '1080p': 3, '720p': 2, '480p': 1, 'SD': 1, '2160p': 0 };

// Release names usually state the audio codec; unnamed audio is often AAC
// (re-encodes) but WEB-DLs without a tag tend to carry E-AC-3
var AUDIO_RANK = { supported: 2, unknown: 1, unsupported: 0 };

var UNSUPPORTED_AUDIO = /\b(ddp?\s?\d|ddp|dd\+|e-?ac-?3|ac-?3|eac3|truehd|atmos|dts(-?hd)?)\b/i,
  SUPPORTED_AUDIO = /\b(aac|opus|mp3)/i;

// The audio codec a name states, first match wins (Atmos rides on E-AC-3 or TrueHD)
var AUDIO_CODECS = [[/\btruehd\b/i, 'truehd'], [/\bdts(.?hd|.?x|.?ma)?\b/i, 'dts'],
  [/\b(ddp\s?\d?|dd\+|e-?ac-?3|eac3)/i, 'eac3'], [/\b(ac-?3|dd\s?\d)/i, 'ac3'], [/\batmos\b/i, 'eac3'],
  [/\baac/i, 'aac'], [/\bopus\b/i, 'opus'], [/\bmp3\b/i, 'mp3'], [/\bflac\b/i, 'flac']];

var HDR = /\b(hdr(10)?(\+|plus)?|dovi|dolby.?vision|dv)\b/i,
  FILE_EXTENSION = /\.(mkv|mp4|m4v|avi|webm|mov|ts|m2ts|wmv|mpg|mpeg|flv|iso)$/i;

// ── what plays ──────────────────────────────────────────────────────────────

function describe(name) {
  name = String(name || '');
  var resolution = (name.match(/\b(2160p|1080p|720p|480p)\b/i) || [])[1];
  if (!resolution && /\b(4k|uhd)\b/i.test(name)) {
    resolution = '2160p';
  }
  resolution = resolution ? resolution.toLowerCase() : 'SD';

  var hevc = /\b(x265|h\.?265|hevc)\b/i.test(name);
  var tenBit = /\b10.?bit\b/i.test(name);
  var xvid = /\b(xvid|divx)\b/i.test(name);

  var audio = 'unknown';
  if (UNSUPPORTED_AUDIO.test(name)) {
    audio = 'unsupported';
  } else if (SUPPORTED_AUDIO.test(name)) {
    audio = 'supported';
  }

  return {
    quality: resolution,
    codec: hevc ? 'x265' : xvid ? 'xvid' : 'x264',
    audio: audio,
    playable: !hevc && !tenBit && !xvid && resolution !== '2160p'
  };
}

// ── titles ──────────────────────────────────────────────────────────────────

function normalizeTitle(text) {
  return String(text).toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ── keyword search (release lists, the dashboard's Search) ─────────────────
// Sites and release names spell titles every way: "Breaking.Bad",
// "breaking_bad", "Breaking Bad", "Spider-Man" / "Spiderman", "Grey's" /
// "Greys". Keywords go to the sites as plain words, and a result counts as a
// match when every keyword is in its name at word boundaries, punctuation and
// joined or split words aside.

/** Accents off, "&" as "and", apostrophes dropped, other signs as spaces (case kept: what sites get) */
function searchWords(text) {
  return String(text || '').normalize('NFD').replace(/\p{M}+/gu, '')
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// a name's words, also split where letters meet digits ("S01E05" → s 01 e 05,
// "1080p" → 1080 p): "s01" and "1080p" still find them, "s" alone doesn't
function nameTokens(name) {
  return searchWords(name).toLowerCase().split(' ').reduce(function (all, word) {
    return all.concat(word.match(/\p{L}+|\p{N}+/gu) || []);
  }, []);
}

function searchMatches(name, text) {
  var words = searchWords(text).toLowerCase().split(' ').filter(Boolean);
  if (!words.length) {
    return true;
  }
  var tokens = nameTokens(name), joined = tokens.join(''), bounds = { 0: true }, at = 0;
  tokens.forEach(function (t) {
    at += t.length;
    bounds[at] = true;
  });

  // a keyword fits when it's a run of whole name words ("breakingbad" fits
  // "Breaking.Bad", "spiderman" fits "Spider-Man")
  function fits(word) {
    for (var i = joined.indexOf(word); i !== -1; i = joined.indexOf(word, i + 1)) {
      if (bounds[i] && bounds[i + word.length]) {
        return true;
      }
    }
    return false;
  }

  // each keyword, else it joined with the next ones ("spider man" fits "Spiderman")
  for (var i = 0; i < words.length;) {
    var j = i + 1, word = words[i];
    while (!fits(word) && j < words.length) {
      word += words[j++];
    }
    if (!fits(word)) {
      return false;
    }
    i = j;
  }
  return true;
}

function titlePrefix(title) {
  return '^' + normalizeTitle(title).replace(/ /g, ' +') + '( (19|20)\\d\\d)?( (us|uk|au|nz|ca))?';
}

// 'episode' when the release is exactly this show's episode ("<title> [year] [US] SxxEyy"),
// 'pack' for a single-season pack of this show ("<title> S02", "<title> Season 2"),
// otherwise null. Rejects other shows that merely contain the words ("Lego Friends",
// "Breaking Brad"), episode ranges ("S01E01-E10", "S01e01 10") and multi-season packs.
// Without a title, only the episode / season is checked.
function matchKind(name, title, season, episode) {
  var normalized = normalizeTitle(name);
  var prefix = title ? titlePrefix(title) : '^.*?';
  var single = new RegExp(prefix + ' s0*' + season + 'e0*' + episode + '(?!\\d)(?! *e?\\d{1,3}\\b)');
  if (single.test(normalized)) {
    return 'episode';
  }
  var pack = new RegExp(prefix + ' (s0*' + season + '|season 0*' + season + ')(?!\\d)(?! *e\\d)(?! *(s?\\d{1,2}\\b|to\\b))');
  return pack.test(normalized) ? 'pack' : null;
}

// ── release lists: title, year, episode ─────────────────────────────────────

// Where the title ends: resolution, source, codecs, audio, edition and
// release-group tags. Short ambiguous words (web, cam, ts, dv, nf) are left
// out: they can be part of a title ("Charlotte's Web").
var JUNK = new RegExp('\\b(' + [
  '2160p', '1080p', '720p', '576p', '480p', '360p', '4k', 'uhd', 'hdr(10)?(\\+|plus)?', 'dovi',
  'web.?dl', 'web.?rip', 'hdrip', 'hdtv', 'pdtv', 'blu.?ray', 'brrip', 'bdrip', 'bd.?remux', 'remux',
  'dvd.?rip', 'dvd.?scr', 'dvdr', 'hdcam', 'telesync', 'hdts', 'telecine',
  'x26[45]', 'h.?26[45]', 'hevc', 'avc', 'xvid', 'divx', '10.?bit',
  'aac\\d?', 'ac3', 'eac3', 'dd[p+]?\\d?', 'atmos', 'dts(.?hd)?', 'truehd', 'opus', 'mp3',
  'proper', 'repack', 'extended', 'unrated', 'remastered', 'imax', 'internal', 'limited',
  'amzn', 'dsnp', 'hmax', 'atvp', 'hulu', 'multi', 'dual.?audio', 'yts', 'yify', 'eztv', 'rarbg'
].join('|') + ')(?![a-z0-9])', 'i');

// Episode / season markers (TV): S01E02, S01E01-E03, S01, Season 2, 2x05, Complete Series
var EPISODE_MARK = /\b(s\d{1,2}\s?e\d{1,3}|s\d{1,2}(?![a-z0-9])|seasons?\s?\d{1,2}|\d{1,2}x\d{2,3}(?!\d)|complete series)/i;

var YEAR = /\b(19|20)\d\d\b/g;

// Leading site tags: "[ www.Torrenting.com ] - ", "www.Site.org - ", "[YTS.MX]"
var SITE_PREFIX = /^\s*((\[[^\]]*\]|\{[^}]*\}|www\.\S+)\s*[-–]?\s*)+/i;

function clean(name) {
  return String(name)
    .replace(/\.(mkv|mp4|avi|m4v|wmv|ts)$/i, '')
    .replace(/\[(eztvx?\.to|eztv\.re|rarbg|yts\.\w+)\]/ig, ' ')
    .replace(SITE_PREFIX, '')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstIndex(text, pattern) {
  var i = text.search(pattern);
  return i > 0 ? i : -1;
}

// season / episode / pack from a TV release name
function episodeOf(text) {
  var m = text.match(/\bs(\d{1,2})\s?e(\d{1,3})(?!\d)/i);
  if (m) {
    return { season: Number(m[1]), episode: Number(m[2]), pack: false };
  }
  m = text.match(/\b(\d{1,2})x(\d{2,3})(?![\dp])/i);
  if (m) {
    return { season: Number(m[1]), episode: Number(m[2]), pack: false };
  }
  // several seasons ("S01-S05", "Season 1-5", "Seasons 1 to 3", "Season 1 2 3"): no single season
  if (/\bs\d{1,2}\s?(-|to|&)\s?s?\d{1,2}\b/i.test(text) ||
    /\bseasons?\s?\d{1,2}\s?((-|to|&|,|and)\s?|\s)\d{1,2}\b(?!p)/i.test(text)) {
    return { season: null, episode: null, pack: true };
  }
  m = text.match(/\bs(\d{1,2})(?![a-z0-9])/i) || text.match(/\bseasons?\s?(\d{1,2})\b/i);
  if (m) {
    return { season: Number(m[1]), episode: null, pack: true };
  }
  if (/\bcomplete( series)?\b/i.test(text)) {
    return { season: null, episode: null, pack: true };
  }
  return { season: null, episode: null, pack: false };
}

// "The.Odyssey.2026.1080p.TELESYNC.HEVC.AAC2.0-SPLiCE" → { title: "The Odyssey", year: 2026 }
// "Blade Runner 2049 2017 1080p" → "Blade Runner 2049", 2017 (last year before the junk)
// "Lioness 2023 S03E01 1080p WEB h264-ETHEL EZTV" → "Lioness", 2023 (+ season 3, episode 1 for tv)
// kind 'tv' adds { season, episode, pack }
function release(name, kind) {
  var text = clean(name);
  // brackets / parentheses around a year or a tag don't end the title by themselves
  var flat = text.replace(/[\[\](){}]/g, ' ').replace(/\s+/g, ' ').trim();

  var cuts = [firstIndex(flat, JUNK), firstIndex(flat, EPISODE_MARK)].filter(function (i) {
    return i > 0;
  });
  var end = cuts.length ? Math.min.apply(null, cuts) : flat.length;
  var head = flat.slice(0, end);

  var year = null;
  var titleEnd = end;
  var years = [], m;
  YEAR.lastIndex = 0;
  while ((m = YEAR.exec(head))) {
    if (m.index > 0) {
      years.push(m);
    }
  }
  if (years.length) {
    var last = years[years.length - 1];
    year = Number(last[0]);
    titleEnd = last.index;
  } else {
    // year after the junk ("Show S01E02 … 2024" is rare, but "Title [1080p] (2024)" isn't)
    var rest = flat.slice(end).match(/\b(19|20)\d\d\b/);
    year = rest ? Number(rest[0]) : null;
  }

  var title = flat.slice(0, titleEnd)
    .replace(/[\s\-–:,(+]+$/, '')
    .replace(/^[\s\-–:]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) {
    title = flat || String(name);
  }

  var presented = { title: title, year: year };
  if (kind === 'tv') {
    var ep = episodeOf(flat.slice(Math.max(0, titleEnd)));
    presented.season = ep.season;
    presented.episode = ep.episode;
    presented.pack = ep.pack;
  }
  return presented;
}

// ── everything a name says ──────────────────────────────────────────────────

function pick(list, text) {
  for (var i = 0; i < list.length; i++) {
    if (list[i][0].test(text)) {
      return list[i][1];
    }
  }
  return null;
}

/**
 * Everything a release or file name says. A path ("Show/Season 2/03.mkv")
 * is read like the library reads one: the folders fill what the name lacks.
 * @returns {{ title: string|null, year: number|null, season: number|null, episode: number|null,
 *   episodeEnd: number|null, pack: boolean, resolution: string|null, source: string|null,
 *   codec: string|null, audio: string|null, hdr: boolean }}
 */
function parse(name) {
  name = String(name || '').slice(0, 1000);
  // the library's parser drops a file's extension: a release name has none
  // to lose (".HEVC", ".DTS" are tags)
  var file = parseFile(FILE_EXTENSION.test(name) ? name : name + '.name'),
    path = name.indexOf('/') !== -1,
    tv = release(name.split('/').pop(), 'tv'),
    flat = name.replace(/[._]/g, ' '),
    season = file.season !== null ? file.season : tv.season,
    episode = file.episode !== null ? file.episode : tv.episode;
  // a release name: the release lists' reading; a path: the library's (its folders)
  return {
    title: (path ? file.title || tv.title : tv.title || file.title) || null,
    year: (path ? file.year || tv.year : tv.year || file.year) || null,
    season: season,
    episode: episode,
    episodeEnd: file.episodeEnd,
    pack: episode === null && !!tv.pack,
    resolution: file.resolution,
    source: file.source,
    codec: file.codec,
    audio: pick(AUDIO_CODECS, flat),
    hdr: HDR.test(flat)
  };
}

/**
 * How a name fits a titleRef (a plugin's `$defs/titleRef`): an episode →
 * 'episode' (that episode), 'pack' (its season) or null; a show → 'episode'
 * or 'pack' when the name is one of this show's; a movie → 'movie' when the
 * name is that film (title, and year ± 1 when both say one); else null.
 */
function matches(name, titleRef) {
  var ref = titleRef || {};
  if (!ref.title || typeof ref.title !== 'string') {
    return null;
  }
  if (ref.kind === 'episode') {
    return matchKind(name, ref.title, ref.season, ref.episode);
  }
  var parsed = parse(name),
    sameTitle = !!parsed.title && normalizeTitle(parsed.title) === normalizeTitle(ref.title),
    yearFits = !parsed.year || !ref.year || Math.abs(parsed.year - ref.year) <= 1;
  if (ref.kind === 'show') {
    if (!new RegExp(titlePrefix(ref.title) + '( |$)').test(normalizeTitle(name))) {
      return null;
    }
    return parsed.episode !== null ? 'episode' : parsed.pack || parsed.season !== null ? 'pack' : null;
  }
  if (ref.kind === 'movie') {
    return sameTitle && yearFits && parsed.episode === null && !parsed.pack ? 'movie' : null;
  }
  return null;
}

// ── ranking ─────────────────────────────────────────────────────────────────

// a, b: { playable, audio, quality, pack, seeds } (describe() + the provider's)
function compare(a, b) {
  return (b.playable - a.playable) ||
    (AUDIO_RANK[b.audio] - AUDIO_RANK[a.audio]) ||
    ((b.seeds >= HEALTHY_SEEDS) - (a.seeds >= HEALTHY_SEEDS)) ||
    (a.pack - b.pack) ||
    ((RESOLUTION_RANK[b.quality] || 0) - (RESOLUTION_RANK[a.quality] || 0)) ||
    (b.seeds - a.seeds);
}

/**
 * The same items in the core's streaming order (plays here → audio that
 * decodes → a healthy swarm → single files before packs → resolution →
 * seeds). Items: { name, seeds?, pack? }, anything else kept as is.
 */
function rank(items) {
  return items.map(function (item, i) {
    var name = String(item && item.name || '');
    return {
      item: item,
      i: i,
      key: Object.assign(describe(name), {
        seeds: Number(item && item.seeds) || 0,
        pack: item && typeof item.pack === 'boolean' ? item.pack : parse(name).pack
      })
    };
  }).sort(function (x, y) {
    return compare(x.key, y.key) || x.i - y.i;
  }).map(function (x) { return x.item; });
}

module.exports = {
  parse: parse,
  describe: describe,
  release: release,
  episodeOf: episodeOf,
  matchKind: matchKind,
  matches: matches,
  normalizeTitle: normalizeTitle,
  searchWords: searchWords,
  searchMatches: searchMatches,
  compare: compare,
  rank: rank,
  AUDIO_RANK: AUDIO_RANK,
  RESOLUTION_RANK: RESOLUTION_RANK,
  HEALTHY_SEEDS: HEALTHY_SEEDS
};
