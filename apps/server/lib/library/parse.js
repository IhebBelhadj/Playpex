'use strict';

// What a video file's path says it is (docs/media-server-plan.md §5.2,
// decision F: our own rules, measured against test/fixtures/filenames.tsv).
//
//   parse('Breaking Bad (2008)/Season 01/Breaking Bad - S01E02 - Cat's in the Bag.mkv')
//   → { kind: 'episode', title: 'Breaking Bad', year: 2008, season: 1, episode: 2, … }
//
// The name is read first: SxxEyy / 1x02 makes an episode, a year a movie
// (the last plausible year: "Blade Runner 2049 2017"). The folders fill
// what the name lacks: "Show/Season 2/03 - Title.mkv", "Heat (1995)/Heat.mkv",
// a scene folder over a short name ("Moonlight.2016…/drones-moonlight.mkv").
// {tmdb-123} / {imdb-tt…} tags (Plex, Jellyfin) give ids directly.

var EPISODE = /\bs(\d{1,2})[ .]?e(\d{1,3})(?:[ -]?e(\d{1,3})|-(\d{1,3})(?!\d))?/i,
  CROSS = /(?:^|[^\dx])(\d{1,2})x(\d{2,3})\b(?![xp])/i,
  SEASON_DIR = /^(?:season|series|saison|staffel)\s*(\d{1,2})\b|^s(\d{1,2})$/i,
  SPECIALS_DIR = /^specials?$/i,
  YEAR = /(?:^|[\s(\[])((?:19|20)\d\d)(?=$|[\s)\]])/g,
  // The first of these ends the title of a name with no year / episode
  NOISE = /\b(2160p|1080[pi]|720p|576p|480p|4k|uhd|bluray|blu-ray|bdrip|brrip|webrip|web-?dl|web|hdtv|hdrip|dvdrip|dvd|remux|x264|x265|h ?264|h ?265|hevc|xvid|divx|aac|ac3|dts|ddp?5 ?1|10 ?bit|hdr|proper|repack|extended|unrated|remastered|directors cut|complete|multi|subbed|dubbed)\b/i,
  EXTRAS = /\b(?:extended|unrated|remastered|director'?s cut|final cut|imax|special edition|theatrical|uncut|criterion)\b/i;

var RESOLUTIONS = [[/\b(2160p|4k|uhd)\b/i, '2160p'], [/\b1080[pi]\b/i, '1080p'], [/\b720p\b/i, '720p'],
    [/\b(576p|480p|dvdrip|dvd)\b/i, '480p']],
  SOURCES = [[/\bremux\b/i, 'remux'], [/\b(bluray|blu-ray|bdrip|brrip|bd)\b/i, 'bluray'],
    [/\bweb-?dl\b/i, 'web-dl'], [/\bwebrip\b/i, 'webrip'], [/\bweb\b/i, 'web'], [/\bhdtv\b/i, 'hdtv'],
    [/\b(dvdrip|dvd)\b/i, 'dvd']],
  CODECS = [[/\b(x265|h ?265|hevc)\b/i, 'hevc'], [/\b(x264|h ?264|avc)\b/i, 'h264'], [/\bav1\b/i, 'av1'],
    [/\b(xvid|divx)\b/i, 'xvid']];

function pick(list, text) {
  for (var i = 0; i < list.length; i++) {
    if (list[i][0].test(text)) {
      return list[i][1];
    }
  }
  return null;
}

// "[ www.site.com ] - The.Name.2010…" → "The Name 2010 …"; ids out of {tmdb-…}
function clean(segment, ids) {
  var s = segment
    .replace(/\{(tmdb|imdb|tvdb)-([a-z0-9]+)\}/gi, function (all, kind, id) {
      ids[kind.toLowerCase()] = id;
      return ' ';
    })
    .replace(/^\s*\[?\s*www\.[a-z0-9.-]+\s*\]?\s*-?\s*/i, '')
    .replace(/^\s*[a-z0-9-]+\.(com|org|net|cz|to|me|se|lol|info|cc)\s+-\s+/i, '')
    .replace(/^\s*\[[^\]]*\]\s*[-.]?\s*/, '');
  // dots and underscores between words are spaces ("Ocean's.Eleven", "Vol.3")
  s = s.replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

function normal(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// The title part: brackets, tags and separators off the ends
function tidy(title) {
  return title
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/[\s\-–:,(\[]+$/, '')
    .replace(/^[\s\-–:,)\]]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// A trailing "(2008)" / " 2005" / " (US)" of a show's name
function splitShow(title) {
  var year = null,
    m = title.match(/^(.+?)[\s(]+((?:19|20)\d\d)\)?$/);
  if (m && tidy(m[1])) {
    year = parseInt(m[2], 10);
    title = m[1];
  }
  return { title: tidy(title.replace(/\((us|uk|au|nz|ca)\)/i, '$1')), year: year };
}

// { title, year } of a movie name, or null when it has no year
function movieName(name) {
  var match, last = null, maxYear = new Date().getFullYear() + 1;
  YEAR.lastIndex = 0;
  while ((match = YEAR.exec(name))) {
    var year = parseInt(match[1], 10),
      at = match.index + match[0].indexOf(match[1]);
    // a year with nothing before it is the title ("1917", "2012 2009")
    if (year <= maxYear && tidy(name.slice(0, at))) {
      last = { year: year, at: at };
    }
    YEAR.lastIndex = match.index + 1;
  }
  if (!last) {
    return null;
  }
  return { title: tidy(name.slice(0, last.at).replace(EXTRAS, ' ')), year: last.year };
}

// The title of a name with neither year nor episode: up to the first noise word
function bareTitle(name) {
  var noise = name.match(NOISE);
  return tidy(noise ? name.slice(0, noise.index) : name);
}

function episodeOf(name) {
  var m = name.match(EPISODE);
  if (m) {
    var end = m[3] || m[4];
    return { at: m.index, season: +m[1], episode: +m[2], episodeEnd: end ? +end : null };
  }
  m = name.match(CROSS);
  if (m) {
    return { at: m.index + m[0].indexOf(m[1]), season: +m[1], episode: +m[2], episodeEnd: null };
  }
  return null;
}

// "03 - Title", "E05", "Episode 21", "101" (with season 1) in a season folder
function numberInSeason(name, season) {
  var m = name.match(/^(?:e|ep|episode)\s*(\d{1,3})\b/i) || name.match(/^(\d{1,2})\b(?!\s*(?:19|20)\d\d)/);
  if (m) {
    return +m[1];
  }
  m = name.match(/^(\d)(\d{2})\b/);
  return m && +m[1] === season ? +m[2] : null;
}

/**
 * @param {string} relPath  '/' separated, inside a library folder
 * @returns {{ kind: 'movie'|'episode'|null, title: string|null, year: number|null,
 *   season: number|null, episode: number|null, episodeEnd: number|null,
 *   resolution: string|null, source: string|null, codec: string|null,
 *   tmdbId: string|null, imdbId: string|null }}
 */
function parse(relPath) {
  var ids = {},
    parts = String(relPath).split('/'),
    file = parts.pop().replace(/\.[a-z0-9]{2,4}$/i, ''),
    dirs = parts.map(function (d) { return clean(d, ids); }),
    name = clean(file, ids),
    all = parts.concat(file).join(' '),
    result = {
      kind: null, title: null, year: null, season: null, episode: null, episodeEnd: null,
      resolution: pick(RESOLUTIONS, all.replace(/[._]/g, ' ')),
      source: pick(SOURCES, all.replace(/[._]/g, ' ')),
      codec: pick(CODECS, all.replace(/[._]/g, ' ')),
      tmdbId: null, imdbId: null
    };

  function done() {
    result.tmdbId = ids.tmdb || null;
    result.imdbId = ids.imdb || null;
    return result;
  }

  function showFrom(title) {
    var show = splitShow(title);
    result.kind = 'episode';
    result.title = show.title || null;
    result.year = show.year;
  }

  // The show's name from the folders: the one above "Season N", else the parent
  function showFromDirs(seasonAt) {
    var at = seasonAt > 0 ? seasonAt - 1 : dirs.length - 1;
    if (at >= 0) {
      var ep = episodeOf(dirs[at]),
        dir = ep ? dirs[at].slice(0, ep.at) : dirs[at].replace(/\b(s\d{1,2}|season \d{1,2})\b.*$/i, '');
      showFrom(tidy(dir));
    }
  }

  var seasonAt = -1, dirSeason = null;
  dirs.forEach(function (d, i) {
    var m = d.match(SEASON_DIR);
    if (m) {
      seasonAt = i;
      dirSeason = +(m[1] || m[2]);
    } else if (SPECIALS_DIR.test(d)) {
      seasonAt = i;
      dirSeason = 0;
    }
  });

  var ep = episodeOf(name);
  if (ep) {
    result.season = ep.season;
    result.episode = ep.episode;
    result.episodeEnd = ep.episodeEnd;
    showFrom(tidy(name.slice(0, ep.at)));
    if (!result.title) {
      showFromDirs(seasonAt);
    } else if (!result.year && seasonAt > 0) {
      // "Show (2005)/Season 2/Show - S02E12.mkv": the year is the folder's
      var folder = splitShow(tidy(dirs[seasonAt - 1]));
      if (folder.year && normal(folder.title) === normal(result.title)) {
        result.year = folder.year;
      }
    }
    return done();
  }

  if (dirSeason !== null) {
    var number = numberInSeason(name, dirSeason);
    if (number !== null) {
      result.season = dirSeason;
      result.episode = number;
      showFromDirs(seasonAt);
      return done();
    }
  }

  var movie = movieName(name),
    parent = dirs.length ? movieName(dirs[dirs.length - 1]) : null;
  movie = movie || parent;
  result.kind = 'movie';
  if (movie) {
    result.title = movie.title || null;
    result.year = movie.year;
  } else {
    result.title = bareTitle(name) || null;
  }
  return done();
}

module.exports = parse;
