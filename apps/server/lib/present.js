'use strict';

// Release name → what a release list shows (title, year, …). Two presenters:
// `adult` (porn naming: "[Studio YYYY]" tags, scene dates) and `release`
// (regular movie / TV naming: "Title.Year.1080p.WEB-DL…", "Show S01E02 …").

// ── 18+ ─────────────────────────────────────────────────────────────────────

// "Heatwave Vol. 2 [Vixen 2026] XXX WEB-DL 1080p SPLIT SCENES MP4-P2P [XC]" →
// title "Heatwave Vol. 2", studio "Vixen", year 2026. Scene names keep their
// date: "Vixen 26 08 20 Gal Ritchie …".
var ADULT_JUNK = /\b(xxx|2160p|1080p|720p|480p|4k|uhd|web.?dl|webrip|hdrip|bluray|dvdrip|split.?scenes?|mp4|mkv|wmv|x26[45]|h\.?26[45]|hevc|p2p|[-.](xc|trb|ktr|gush|wrb|nbq|xleech))\b/i;

function adult(name) {
  var text = String(name)
    .replace(/\.(mp4|mkv|avi|wmv)$/i, '')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  var studio = null, year = null;
  var bracket = text.match(/\[([^\]]+?)\s+((19|20)\d\d)\]/);
  if (bracket) {
    studio = bracket[1].trim();
    year = Number(bracket[2]);
  }

  var title = text.replace(/\[[^\]]*\]/g, ' ');
  var junk = title.search(ADULT_JUNK);
  if (junk > 0) {
    title = title.slice(0, junk);
  }
  title = title.replace(/[\s\-–(]+$/, '').replace(/\s+/g, ' ').trim();
  if (title.length < 3) {
    title = text;
  }
  return { title: title, studio: studio, year: year };
}

// ── movies / TV ─────────────────────────────────────────────────────────────

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

  var presented = { title: title, year: year, studio: null };
  if (kind === 'tv') {
    var ep = episodeOf(flat.slice(Math.max(0, titleEnd)));
    presented.season = ep.season;
    presented.episode = ep.episode;
    presented.pack = ep.pack;
  }
  return presented;
}

module.exports = {
  adult: adult,
  release: release,
  episodeOf: episodeOf
};
