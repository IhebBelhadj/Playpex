// The Stremio add-on bridge's adapter (docs/stremio-bridge-plan.md §6–§8):
// code the server ships, run in the sandbox of every bridged add-on's plugin.
// It never sees the add-on's address: it asks through the core-only calls
// stremio.addon / stremio.get / stremio.streams (lib/plugins/stremio), which
// fetch, check and clean the answers, and maps them to Playpex's shapes.
//
//   play.collect         stream/{movie|series}/{tt…[:s:e]} → magnet, http, hls sources (≤ 50: links first, then
//                        torrents by seeders as the add-on says)
//   subtitles.providers  subtitles/… with the file's hash, size and name when the server knows them
//   data movieRows / showRows / searchChip / home / page / title / play
//                        its catalogs as rows (where the admin placed them), its section, its title pages

var MAX_SOURCES = 50,
  ROW_SIZE = 100,
  QUALITIES = [['2160p', /\b(2160p|4k|uhd)\b/i], ['1080p', /\b1080p\b/i], ['720p', /\b720p\b/i], ['480p', /\b(480p|576p)\b/i], ['SD', /\b(sd|360p|240p)\b/i]];

var info = null;

// A hook its manifest has (one add-on answers streams, another only subtitles): the sandbox refuses the others
function on(name, fn) {
  try {
    playpex.hooks.on(name, fn);
  } catch (err) {
    if (err.code !== 'PERMISSION_DENIED') {
      throw err;
    }
  }
}

// what the add-on offers and where the admin placed its catalogs (read again for every screen and row: the
// core caches the add-on's manifest, and the admin's choices apply at once)
function addon() {
  return playpex.core.call('stremio.addon').then(function (a) {
    info = a;
    return a;
  });
}

function fresh() {
  return addon();
}

function get(resource, type, id, extra) {
  return playpex.core.call('stremio.get', { resource: resource, type: type, id: id, extra: extra || null });
}

function lines(text) {
  return String(text || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
}

function cut(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ── streams ─────────────────────────────────────────────────────────────────

function seedersOf(text) {
  var m = /👤\s*(\d{1,7})/.exec(text) || /(?:seed(?:er)?s?|⬆️|🌱)\s*[:=]?\s*(\d{1,7})/i.exec(text);
  return m ? parseInt(m[1], 10) : null;
}

function sizeOf(text) {
  var m = /(?:💾|size\s*[:=]?)\s*([\d.,]+)\s*(TB|GB|MB|KB|GiB|MiB|TiB|KiB)\b/i.exec(text);
  if (!m) {
    return null;
  }
  var n = parseFloat(m[1].replace(',', '.')), unit = m[2].toUpperCase().replace('I', '');
  return isFinite(n) ? Math.round(n * { KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 }[unit]) : null;
}

function qualityOf(text) {
  for (var i = 0; i < QUALITIES.length; i++) {
    if (QUALITIES[i][1].test(text)) {
      return QUALITIES[i][0];
    }
  }
  return null;
}

/** The release name a stream stands for: its file, else its title's first line that isn't the add-on's */
function releaseOf(s) {
  var t = lines(s.title);
  var first = t.filter(function (l) { return !/👤|💾|⚙️/.test(l); })[0];
  return s.filename || first || lines(s.name).join(' ') || 'Stream';
}

/** One Stream → a Playpex source, or null (a kind Playpex doesn't play here) */
function sourceOf(s, options) {
  var text = [s.name, s.title].filter(Boolean).join('\n'),
    via = lines(s.name).join(' · '),
    label = cut(releaseOf(s), 200),
    notes = [];
  if (options.addon && via.indexOf(options.addon) === -1) {
    notes.push(cut(options.addon, 80));
  }
  if (via) {
    notes.push(cut(via, 80));
  }
  var size = s.videoSize || sizeOf(text), quality = qualityOf(text);
  if (s.kind === 'torrent') {
    var seeds = seedersOf(text), src = { kind: 'magnet', infoHash: s.infoHash, label: label };
    if (s.fileIdx !== null && s.fileIdx !== undefined) {
      src.fileIndex = s.fileIdx;
    }
    if (s.filename) {
      src.fileName = cut(s.filename, 500);
    }
    if (size) {
      src.size = size;
    }
    if (seeds !== null) {
      src.seeds = seeds;
      notes.push('Seeders as the add-on says');
    }
    if (quality) {
      src.quality = quality;
    }
    if (s.bingeGroup) {
      src.bingeGroup = cut(s.bingeGroup, 200);
    }
    src.notes = notes.slice(0, 6);
    return src;
  }
  if (s.kind === 'url') {
    if (!/^https:\/\//i.test(s.url)) {
      return null;   // plain http: only for addresses the admin types (M3U), never one an add-on answers
    }
    var hls = /\.m3u8(\?|#|$)/i.test(s.url),
      out = { kind: hls ? 'hls' : 'http', url: s.url, label: label };
    if (s.headers) {
      out.headers = s.headers;
    }
    if (size && !hls) {
      out.size = size;
    }
    if (quality) {
      out.quality = quality;
    }
    if (s.bingeGroup) {
      out.bingeGroup = cut(s.bingeGroup, 200);
    }
    out.notes = notes.slice(0, 6);
    return out;
  }
  if (s.kind === 'archive') {
    // a stored file inside a rar / zip / tar: the server reads the archive and streams the file
    var arch = { kind: 'http', url: s.archive.parts[0].url, label: label, archive: { format: s.archive.format, parts: s.archive.parts } };
    if (s.archive.fileIndex !== undefined) {
      arch.archive.fileIndex = s.archive.fileIndex;
    }
    if (s.archive.fileMustInclude) {
      arch.archive.fileMustInclude = s.archive.fileMustInclude;
    }
    if (s.headers) {
      arch.headers = s.headers;
    }
    if (size) {
      arch.size = size;
    }
    if (quality) {
      arch.quality = quality;
    }
    if (s.bingeGroup) {
      arch.bingeGroup = cut(s.bingeGroup, 200);
    }
    notes.push('In a ' + s.archive.format + ' archive');
    arch.notes = notes.slice(0, 6);
    return arch;
  }
  if (s.kind === 'youtube' && options.embed) {
    return { kind: 'embed', provider: 'youtube', id: s.ytId, label: label };
  }
  return null;
}

/** Links first (the add-on's order: a debrid service's ready files), then torrents by seeders; one per hash */
function sourcesOf(streams, options) {
  var links = [], torrents = [], seen = {}, dropped = 0;
  streams.forEach(function (s) {
    if (s.countryWhitelist && s.countryWhitelist.length && options.region && s.countryWhitelist.indexOf(options.region) === -1) {
      dropped++;
      return;
    }
    var src = sourceOf(s, { addon: s.addon || null, embed: options.embed });
    if (!src) {
      dropped++;
      return;
    }
    if (src.kind === 'magnet') {
      if (seen[src.infoHash]) {
        return;
      }
      seen[src.infoHash] = true;
      torrents.push(src);
    } else {
      links.push(src);
    }
  });
  torrents.sort(function (a, b) { return (b.seeds || 0) - (a.seeds || 0); });
  if (dropped) {
    playpex.log.info(dropped + ' stream' + (dropped === 1 ? '' : 's') + ' Playpex can\'t play (other kinds, plain http, another country)');
  }
  return links.slice(0, MAX_SOURCES).concat(torrents).slice(0, options.max || MAX_SOURCES);
}

function streamId(title) {
  if (!title.imdbId) {
    return null;
  }
  return title.kind === 'episode' ? { type: 'series', id: title.imdbId + ':' + title.season + ':' + title.episode } :
    title.kind === 'movie' ? { type: 'movie', id: title.imdbId } : null;
}

on('play.collect', function (input) {
  var asked = streamId(input.title || {});
  if (!asked) {
    return [];
  }
  return (info ? Promise.resolve(info) : addon()).then(function (a) {
    if (!a.play) {
      return [];
    }
    return get('stream', asked.type, asked.id).then(function (answer) {
      return sourcesOf(answer.streams || [], { embed: false });
    });
  });
});

// ── subtitles ───────────────────────────────────────────────────────────────

var LANGUAGES = {
  eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', ita: 'it', por: 'pt', pob: 'pt-BR', rus: 'ru', jpn: 'ja',
  kor: 'ko', chi: 'zh', zho: 'zh', ara: 'ar', heb: 'he', tur: 'tr', pol: 'pl', dut: 'nl', nld: 'nl', swe: 'sv', nor: 'no',
  dan: 'da', fin: 'fi', cze: 'cs', ces: 'cs', slo: 'sk', slk: 'sk', slv: 'sl', hun: 'hu', rum: 'ro', ron: 'ro', bul: 'bg',
  gre: 'el', ell: 'el', srp: 'sr', hrv: 'hr', bos: 'bs', mac: 'mk', mkd: 'mk', alb: 'sq', sqi: 'sq', ukr: 'uk', est: 'et',
  lav: 'lv', lit: 'lt', ice: 'is', isl: 'is', per: 'fa', fas: 'fa', hin: 'hi', ben: 'bn', tha: 'th', vie: 'vi', ind: 'id',
  may: 'ms', msa: 'ms', cat: 'ca', baq: 'eu', eus: 'eu', glg: 'gl', geo: 'ka', kat: 'ka', arm: 'hy', hye: 'hy', tam: 'ta',
  tel: 'te', mal: 'ml', urd: 'ur', fil: 'tl', tgl: 'tl', 'pt-br': 'pt-BR'
};
var NAMES = { en: 'English', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese', 'pt-BR': 'Portuguese (Brazil)',
  ru: 'Russian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ar: 'Arabic', he: 'Hebrew', tr: 'Turkish', pl: 'Polish', nl: 'Dutch',
  sv: 'Swedish', no: 'Norwegian', da: 'Danish', fi: 'Finnish', cs: 'Czech', sk: 'Slovak', sl: 'Slovenian', hu: 'Hungarian',
  ro: 'Romanian', bg: 'Bulgarian', el: 'Greek', sr: 'Serbian', hr: 'Croatian', uk: 'Ukrainian', fa: 'Persian', hi: 'Hindi',
  th: 'Thai', vi: 'Vietnamese', id: 'Indonesian' };

function languageOf(code) {
  var c = String(code || '').trim(), k = c.toLowerCase();
  if (LANGUAGES[k]) {
    return LANGUAGES[k];
  }
  var m = /^([a-z]{2,3})(?:[-_]([A-Za-z]{2,4}))?$/.exec(c);
  return m ? m[1].toLowerCase() + (m[2] ? '-' + m[2].toUpperCase() : '') : null;
}

on('subtitles.providers', function (input) {
  var asked = streamId(input.title || {});
  if (!asked) {
    return [];
  }
  return (info ? Promise.resolve(info) : addon()).then(function (a) {
    if (!a.subtitles) {
      return [];
    }
    var extra = {};
    if (input.hash) {
      extra.videoHash = input.hash;
    }
    if (input.size) {
      extra.videoSize = input.size;
    }
    if (input.fileName) {
      extra.filename = input.fileName;
    }
    return get('subtitles', asked.type, asked.id, extra).then(function (answer) {
      var wanted = (input.languages || []).map(function (l) { return String(l).split('-')[0]; }),
        seen = {}, out = [];
      (answer.subtitles || []).forEach(function (s) {
        var lang = languageOf(s.lang);
        if (!lang || seen[s.url] || out.length >= 100) {
          return;
        }
        seen[s.url] = true;
        out.push({
          id: cut(s.id, 100).replace(/[^A-Za-z0-9._:-]/g, '_') || String(out.length),
          language: lang,
          label: cut((NAMES[lang] || lang) + (s.fileName ? ' · ' + s.fileName : ''), 200),
          url: s.url,
          format: /\.vtt(\?|$)/i.test(s.fileName || s.url) ? 'vtt' : /\.ass(\?|$)/i.test(s.fileName || '') ? 'ass' : 'srt'
        });
      });
      // the profile's languages first
      out.sort(function (x, y) {
        return (wanted.indexOf(x.language.split('-')[0]) === -1 ? 1 : 0) - (wanted.indexOf(y.language.split('-')[0]) === -1 ? 1 : 0);
      });
      return out;
    });
  });
});

// ── the dashboard's Search ──────────────────────────────────────────────────

// Keywords → its movie search catalogs' first films → every bridged add-on's streams for them
on('sources.search', function (input) {
  if (input.kind === 'show' || input.page > 1) {
    return { results: [], last: true };
  }
  return fresh().then(function (a) {
    var cats = a.catalogs.filter(function (c) { return c.search && c.type === 'movie' && c.show !== 'hidden'; }).slice(0, 2);
    return Promise.all(cats.map(function (c) {
      return get('catalog', c.type, c.id, { search: String(input.query).slice(0, 200) }).then(function (r) { return r.metas || []; }, function () { return []; });
    }));
  }).then(function (lists) {
    var films = [], seen = {};
    lists.forEach(function (l) {
      l.forEach(function (m) {
        if (/^tt\d+$/.test(m.id) && !seen[m.id] && films.length < 3) {
          seen[m.id] = true;
          films.push(m);
        }
      });
    });
    return Promise.all(films.map(function (m) {
      return playpex.core.call('stremio.streams', { type: 'movie', id: m.id }).then(function (answer) {
        return sourcesOf(answer.streams || [], { embed: false, max: 12 }).map(function (src) {
          var r = { source: src, title: cut(m.name, 200) };
          var year = parseInt(String(m.releaseInfo || '').slice(0, 4), 10);
          if (year >= 1870 && year <= 2100) {
            r.year = year;
          }
          if (m.poster) {
            r.poster = m.poster;
          }
          return r;
        });
      }, function () { return []; });
    }));
  }).then(function (groups) {
    return { results: [].concat.apply([], groups).slice(0, 100), last: true };
  });
});

// ── catalogs ────────────────────────────────────────────────────────────────

function pluginId() {
  return info ? info.id : 'stremio';
}

function variantOf(shape) {
  return shape === 'landscape' ? 'still' : 'poster';
}

/** A MetaPreview → a card: TMDB's titles open the core's pages, others its own */
function card(m) {
  var c = { key: cut(m.id, 200), title: cut(m.name, 200), variant: variantOf(m.posterShape) };
  if (m.poster) {
    c.image = m.poster;
  }
  if (m.releaseInfo) {
    c.subtitle = cut(m.releaseInfo, 200);
  }
  if (m.imdbRating) {
    c.rating = { source: 'provider', value: m.imdbRating };
  }
  if (m.tmdbId && m.tmdbKind && /^tt/.test(m.id)) {
    c.intent = { screen: m.tmdbKind === 'movie' ? 'core.movie' : 'core.show', params: { id: m.tmdbId } };
  } else {
    c.intent = { screen: 'plugin.' + pluginId() + '.title', params: { type: cut(m.type || 'movie', 40), id: m.id } };
  }
  var tinfo = { title: cut(m.name, 200) };
  if (m.description) {
    tinfo.overview = cut(m.description, 4000);
  }
  if (m.genres && m.genres.length) {
    tinfo.genres = m.genres.slice(0, 8);
  }
  if (m.background) {
    tinfo.backdrop = m.background;
  }
  var meta = [];
  if (m.releaseInfo) {
    meta.push({ kind: 'text', text: cut(m.releaseInfo, 80) });
  }
  if (m.imdbRating) {
    meta.push({ kind: 'score', source: 'provider', value: m.imdbRating, label: 'IMDb' });
  }
  if (meta.length) {
    tinfo.meta = meta;
  }
  c.info = tinfo;
  return c;
}

function rowKey(c, suffix) {
  return cut(pluginId() + ':' + c.key + (suffix ? ':' + suffix : ''), 100);
}

/** A catalog as a row: paged when the add-on pages it (skip), else its one answer */
function catalogRow(c, extra) {
  var title = cut(c.name, 200);
  if (c.paged && !(extra && extra.search)) {
    return Promise.resolve({ key: rowKey(c, extra && extra.genre), title: title, page: { data: 'page', args: { key: c.key, genre: (extra && extra.genre) || '' } } });
  }
  return get('catalog', c.type, c.id, extra).then(function (answer) {
    var items = (answer.metas || []).slice(0, ROW_SIZE).map(card);
    return items.length ? { key: rowKey(c, extra && (extra.genre || 'search')), title: title, items: items } : null;
  }, function (err) {
    playpex.log.warn('catalog ' + c.name + ': ' + err.message);
    return null;
  });
}

function rowsFor(place, extra, max) {
  return fresh().then(function (a) {
    var cats = a.catalogs.filter(function (c) { return c.show === place && !c.genreRequired; });
    return Promise.all(cats.map(function (c) { return catalogRow(c, extra); }));
  }).then(function (rows) {
    return rows.filter(Boolean).slice(0, max);
  });
}

// Stremio's skip counts the items already shown: a catalog's page size is what its first page holds (Cinemeta 49,
// others 20 or 100), learnt once per sandbox
var pageSizes = {};

function catalogPage(c, genre, page) {
  var key = c.key + '\n' + (genre || '');
  function ask(n, size) {
    var extra = {};
    if (genre) {
      extra.genre = genre;
    }
    if (n > 1) {
      extra.skip = (n - 1) * size;
    }
    return get('catalog', c.type, c.id, extra).then(function (answer) { return answer.metas || []; });
  }
  if (page === 1 || pageSizes[key]) {
    return ask(page, pageSizes[key] || 0).then(function (metas) {
      if (page === 1 && metas.length) {
        pageSizes[key] = metas.length;
      }
      return metas;
    });
  }
  return ask(1, 0).then(function (first) {
    pageSizes[key] = first.length || ROW_SIZE;
    return first.length ? ask(page, pageSizes[key]) : [];
  });
}

playpex.data('page', function (args) {
  return fresh().then(function (a) {
    var c = a.catalogs.filter(function (x) { return x.key === args.key; })[0];
    if (!c) {
      return { data: { items: [], last: true } };
    }
    var page = args.page || 1;
    return catalogPage(c, args.genre || '', page).then(function (metas) {
      var size = pageSizes[c.key + '\n' + (args.genre || '')] || ROW_SIZE;
      // a short page (or an empty one) is the end; a catalog that doesn't page has one
      return { data: { items: metas.slice(0, ROW_SIZE).map(card), last: !c.paged || !metas.length || (page > 1 && metas.length < size) } };
    });
  });
});

playpex.data('movieRows', function () {
  return rowsFor('movies', null, 4).then(function (rows) { return { data: rows }; });
});

playpex.data('showRows', function () {
  return rowsFor('shows', null, 4).then(function (rows) { return { data: rows }; });
});

playpex.data('searchChip', function (args) {
  var query = String((args.context && args.context.query) || '').trim();
  return fresh().then(function (a) {
    var cats = a.catalogs.filter(function (c) { return c.search && c.show !== 'hidden'; });
    if (!query) {
      return [];
    }
    return Promise.all(cats.slice(0, 10).map(function (c) { return catalogRow(Object.assign({}, c, { paged: false }), { search: query.slice(0, 200) }); }));
  }).then(function (rows) {
    return { data: { chip: { key: pluginId() + ':search', label: cut(info ? info.name : 'Add-on', 20) }, rows: rows.filter(Boolean) } };
  });
});

// its section: the catalogs placed there, a search, a genre filter
playpex.data('home', function (args) {
  var query = String(args.query || '').trim(),
    genre = ((args.filters && args.filters.genre) || [])[0] || '';
  return fresh().then(function (a) {
    var cats = a.catalogs.filter(function (c) { return c.show === 'section'; }),
      genres = [];
    cats.forEach(function (c) {
      c.genres.forEach(function (g) {
        if (genres.indexOf(g) === -1 && genres.length < 39) {
          genres.push(g);
        }
      });
    });
    var filters = genres.length ? [{ key: 'genre', label: 'Genre', options: [{ value: '', label: 'All', on: !genre }].concat(genres.map(function (g) {
      return { value: g, label: cut(g, 40), on: g === genre };
    })) }] : [];
    var searchable = cats.filter(function (c) { return c.search; }).concat(a.catalogs.filter(function (c) { return c.show === 'search'; }));
    if (args.preview) {
      return { data: { rows: [], filters: filters } };
    }
    var work;
    if (query) {
      work = Promise.all(searchable.slice(0, 10).map(function (c) { return catalogRow(Object.assign({}, c, { paged: false }), { search: query.slice(0, 200) }); }));
    } else {
      work = Promise.all(cats.filter(function (c) {
        return !genre ? !c.genreRequired : c.genres.indexOf(genre) !== -1;
      }).map(function (c) { return catalogRow(c, genre ? { genre: genre } : null); }));
    }
    return work.then(function (rows) {
      return { data: {
        title: cut(a.name, 200),
        search: searchable.length > 0,
        filters: filters,
        rows: rows.filter(Boolean).slice(0, 30),
        empty: query ? 'Nothing found for “' + cut(query, 60) + '”.' : 'This add-on\'s catalogs show elsewhere (its Settings on the dashboard).'
      } };
    });
  });
});

// ── title pages ─────────────────────────────────────────────────────────────

function videoCard(v, type, m) {
  var c = {
    key: cut(v.id, 200),
    title: cut(v.title || (v.episode ? 'Episode ' + v.episode : v.id), 200),
    variant: 'still',
    call: { data: 'play', args: { type: type, id: v.id, title: cut(m.name, 150), subtitle: cut(v.title || '', 150) } }
  };
  if (v.thumbnail || m.background) {
    c.image = v.thumbnail || m.background;
  }
  var sub = [];
  if (v.season !== null && v.season !== undefined && v.episode !== null && v.episode !== undefined) {
    sub.push('S' + v.season + ' E' + v.episode);
  }
  if (v.released) {
    sub.push(String(v.released).slice(0, 10));
  }
  if (sub.length) {
    c.subtitle = sub.join(' · ');
  }
  if (v.overview) {
    c.info = { title: c.title, overview: cut(v.overview, 4000) };
  }
  return c;
}

playpex.data('title', function (args) {
  var params = args.params || {}, type = String(params.type || 'movie'), id = String(params.id || '');
  return get('meta', type, id).then(function (answer) {
    var m = answer.meta;
    if (!m) {
      return { data: { info: { title: 'Not found', overview: 'The add-on has nothing for this any more.' } } };
    }
    var meta = [];
    if (m.releaseInfo) {
      meta.push({ kind: 'text', text: cut(m.releaseInfo, 80) });
    }
    if (m.runtime) {
      meta.push({ kind: 'text', text: cut(m.runtime, 80) });
    }
    if (m.imdbRating) {
      meta.push({ kind: 'score', source: 'provider', value: m.imdbRating, label: 'IMDb' });
    }
    var tinfo = { title: cut(m.name, 200), meta: meta, genres: m.genres.slice(0, 8) };
    if (m.description) {
      tinfo.overview = cut(m.description, 4000);
    }
    if (m.background) {
      tinfo.backdrop = m.background;
    }
    var credits = [];
    if (m.director && m.director.length) {
      credits.push({ label: 'Director', names: m.director.slice(0, 20) });
    }
    if (m.cast && m.cast.length) {
      credits.push({ label: 'Cast', names: m.cast.slice(0, 20) });
    }
    if (credits.length) {
      tinfo.credits = credits;
    }
    var videos = m.videos || [], actions = [], rows = [];
    if (!videos.length) {
      actions.push({ key: pluginId() + ':play', label: 'Play', icon: 'play', call: { data: 'play', args: { type: type, id: m.id, title: cut(m.name, 150) } } });
    } else {
      // by season (the add-on's order inside one), channels and TV newest first
      var seasons = {}, order = [];
      videos.forEach(function (v) {
        var s = v.season === null || v.season === undefined ? -1 : v.season;
        if (!seasons[s]) {
          seasons[s] = [];
          order.push(s);
        }
        seasons[s].push(v);
      });
      order.sort(function (a, b) { return (a === 0 ? 1e6 : a) - (b === 0 ? 1e6 : b); });
      if (type === 'channel' || type === 'tv') {
        order.reverse();
      }
      order.slice(0, 10).forEach(function (s) {
        var list = seasons[s].slice();
        if (type === 'channel' || type === 'tv') {
          list.reverse();
        }
        rows.push({
          key: cut(pluginId() + ':season:' + s, 100),
          title: s === -1 ? 'Videos' : s === 0 ? 'Specials' : 'Season ' + s,
          variant: 'still',
          items: list.slice(0, 100).map(function (v) { return videoCard(v, type, m); })
        });
      });
      var first = videos.filter(function (v) { return v.season !== 0; })[0] || videos[0];
      actions.push({ key: pluginId() + ':play', label: 'Play', icon: 'play', call: { data: 'play', args: { type: type, id: first.id, title: cut(m.name, 150), subtitle: cut(first.title || '', 150) } } });
    }
    return { data: { info: tinfo, actions: actions, rows: rows } };
  });
});

// Enter on a video (or Play): every bridged add-on's streams for it, as a play effect
playpex.data('play', function (args) {
  var type = String(args.type || 'movie'), id = String(args.id || '');
  return playpex.core.call('stremio.streams', { type: type, id: id }).then(function (answer) {
    var sources = sourcesOf(answer.streams || [], { embed: true, max: 50 });
    if (!sources.length) {
      return { effects: [{ type: 'toast', tone: 'error', text: answer.errors && answer.errors.length ? 'The add-ons didn\'t answer' :
        'No add-on has a stream for this' }] };
    }
    var request = { title: cut(args.title || 'Video', 200), sources: sources };
    if (args.subtitle) {
      request.subtitle = cut(args.subtitle, 200);
    }
    return { effects: [{ type: 'play', request: request }] };
  });
});
