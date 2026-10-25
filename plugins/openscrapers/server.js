// OpenScrapers (a port of the Kodi add-on script.module.openscrapers 0.0.2.012,
// GPL-3.0, a4k-openproject: see LICENSE). Of its ~130 Python
// scrapers, the ones whose sites still answer (checked 2026-10-25) and give
// something Playpex plays, each behind a switch in the plugin's settings:
//
//   direct files   BnW Movies (en/bnwmovies.py): public-domain films, MP4s on archive.org
//                  netzkino (de/netzkino.py): free German films; its CDN plays only from
//                  Germany, Austria, Switzerland… (CloudFront geo-block): off by default
//   torrents       LimeTorrents (en_Torrent/limetorrents.py), TorrentDownload
//                  (torrentdownload.py), Nyaa (nyaa.py, anime)
//
// Left out: scrapers that only link to file hosts (Kodi's ResolveURL turns those
// into videos: not part of OpenScrapers), accounts (Furk, Easynews, debrid), sites
// behind Cloudflare challenges (TorLock, YourBittorrent, TorrentFunk), parked or
// gone ones, and the sites the "Torrent sites" plugins already read (The Pirate
// Bay, EZTV, YTS, TheRARBG).
//
//   play.collect        a movie: direct files (title + year) and torrents ("<title> <year>");
//                       an episode: torrents "<show> SxxEyy" and "<show> Sxx" (packs);
//                       kept: what the core's matcher (playpex.names.matches) says is that title
//   sources.search      keywords → the direct files (the dashboard's Search)
//   releases.providers  keywords → every torrent site's results, most seeded first (one page);
//                       without keywords: LimeTorrents' top movies / TV by seeds
//
// Runs in the server's sandbox (docs/plugins/server.md). Educational project:
// streaming copyrighted content may be illegal where you live.

var HASH = /^[0-9a-fA-F]{40}$/,
  MAX_SOURCES = 50,
  LIME = ['https://www.limetorrents.fun', 'https://www.limetorrents.info'],
  TORRENTDOWNLOAD = 'https://www.torrentdownload.info',
  NYAA = 'https://nyaa.si',
  BNW = 'https://bnwmovies.com',
  NETZKINO_API = 'https://api.netzkino.de.simplecache.net/capi-2.0a/search',
  NETZKINO_CDN = 'https://pmd.netzkino-seite.netzkino.de/',
  // each site gets 5 s: one that hangs (LimeTorrents now and then) mustn't sink the others' answers
  WAIT_MS = 5000;

// ── helpers ─────────────────────────────────────────────────────────────────

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

/** Plain words: what every site's search takes */
function words(text) {
  return String(text || '').replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function dashed(text) {
  return words(text).toLowerCase().replace(/ /g, '-');
}

/** "925.34 MB", "4.1 GiB", "1,24 GB" → bytes */
function bytes(text) {
  var m = /([\d.,]+)\s*([KMGT]i?B)/i.exec(String(text || ''));
  if (!m) {
    return 0;
  }
  var unit = { K: 1, M: 2, G: 3, T: 4 }[m[2][0].toUpperCase()];
  return Math.round(parseFloat(m[1].replace(',', '.')) * Math.pow(1024, unit));
}

function count(text) {
  return parseInt(String(text || '').replace(/[^\d]/g, ''), 10) || 0;
}

function enabled(key, ctx) {
  return playpex.settings.get(key, ctx).then(function (v) { return v !== false; }, function () { return false; });
}

function page(url) {
  return playpex.http.request({ url: url, headers: { Accept: 'text/html' }, timeoutMs: WAIT_MS }).then(function (r) {
    if (r.status !== 200) {
      throw new Error(url.split('/')[2] + ' answered HTTP ' + r.status);
    }
    return String(r.body || '');
  });
}

/** The first of these bases that answers this path */
function pageFrom(bases, path) {
  var i = 0;
  function attempt() {
    return page(bases[i] + path).catch(function (err) {
      // the next mirror after a refusal; a silent site isn't waited for twice
      if (err.code !== 'TIMEOUT' && ++i < bases.length) {
        return attempt();
      }
      throw err;
    });
  }
  return attempt();
}

/** Each site on its own: one failing never sinks the others */
function settle(list) {
  return Promise.all(list.map(function (p) {
    return p.catch(function (err) {
      playpex.log.warn(err.message);
      return [];
    });
  })).then(function (lists) { return [].concat.apply([], lists); });
}

// ── torrent sites: each answers [{ name, hash, size, seeds, peers, uploadedAt? }] ─

var torrents = {
  // /search/<all|movies|tv>/<words-dashed>/seeds/1/ ; a row: the .torrent link names the hash
  limetorrents: function (query, kind) {
    var section = kind === 'movie' ? 'movies' : kind === 'show' ? 'tv' : 'all';
    return pageFrom(LIME, '/search/' + section + '/' + encodeURIComponent(dashed(query)) + '/seeds/1/').then(limeRows);
  },
  // /search?q= ; a row's link is /<hash>/<name>
  torrentdownload: function (query) {
    return page(TORRENTDOWNLOAD + '/search?q=' + encodeURIComponent(words(query))).then(function (html) {
      return playpex.html.select(html, 'table.table2 tr', {
        link: 'div.tt-name a@href', name: 'div.tt-name a', size: 'td.tdnormal:nth-child(3)', seeds: 'td.tdseed', peers: 'td.tdleech'
      }).then(function (rows) {
        // the first rows are ads (no hash in their link)
        return rows.map(function (r) {
          var hash = (/^\/([0-9a-fA-F]{40})\//.exec(r.link || '') || [])[1];
          return hash && r.name && {
            // its names put _ for spaces ("Night_of_the_Living_Dead_(2012)_1080p"): spaces again, so the core reads them
            name: String(r.name).replace(/_/g, ' ').replace(/\s+/g, ' ').trim(), hash: hash.toLowerCase(), size: bytes(r.size), seeds: count(r.seeds), peers: count(r.peers)
          };
        }).filter(Boolean);
      });
    });
  },
  // /?q=&s=seeders&o=desc ; anime (category 1_2: English-translated) for shows, everything else as asked
  nyaa: function (query, kind) {
    var category = kind === 'show' ? '1_2' : '0_0';
    return page(NYAA + '/?f=0&c=' + category + '&s=seeders&o=desc&q=' + encodeURIComponent(words(query))).then(function (html) {
      return playpex.html.select(html, 'table.torrent-list tbody tr', {
        name: 'td:nth-child(2) a:not(.comments)@title', magnet: 'a[href^="magnet:"]@href', size: 'td:nth-child(4)',
        time: 'td:nth-child(5)@data-timestamp', seeds: 'td:nth-child(6)', peers: 'td:nth-child(7)'
      }).then(function (rows) {
        return rows.map(function (r) {
          var hash = (/btih:([0-9a-fA-F]{40})/.exec(r.magnet || '') || [])[1];
          return hash && r.name && {
            name: r.name, hash: hash.toLowerCase(), size: bytes(r.size), seeds: count(r.seeds), peers: count(r.peers),
            uploadedAt: r.time ? new Date(Number(r.time) * 1000).toISOString() : undefined
          };
        }).filter(Boolean);
      });
    });
  }
};

function limeRows(html) {
  return playpex.html.select(html, 'table.table2 tr', {
    torrent: 'a.csprite_dl14@href', name: 'div.tt-name a:nth-child(2)', size: 'td.tdnormal:nth-child(3)', seeds: 'td.tdseed', peers: 'td.tdleech'
  }).then(function (rows) {
    return rows.map(function (r) {
      var hash = (/\/torrent\/([0-9a-fA-F]{40})\.torrent/.exec(r.torrent || '') || [])[1];
      return hash && r.name && { name: r.name, hash: hash.toLowerCase(), size: bytes(r.size), seeds: count(r.seeds), peers: count(r.peers) };
    }).filter(Boolean);
  });
}

/** The enabled sites' results for keywords, each torrent once (the best seeded) */
function searchTorrents(query, kind, ctx) {
  return Promise.all(Object.keys(torrents).map(function (site) { return enabled(site, ctx); })).then(function (on) {
    return settle(Object.keys(torrents).filter(function (s, i) { return on[i]; }).map(function (site) {
      return torrents[site](query, kind);
    }));
  }).then(function (all) {
    var byHash = {};
    all.forEach(function (t) {
      if (HASH.test(t.hash) && (!byHash[t.hash] || t.seeds > byHash[t.hash].seeds)) {
        byHash[t.hash] = t;
      }
    });
    return Object.keys(byHash).map(function (h) { return byHash[h]; }).sort(function (a, b) { return b.seeds - a.seeds; });
  });
}

// ── direct files: each answers [{ title, year, poster?, url, label, size?, quality }] ─

var direct = {
  // the search's h3 links → each film's page: its MP4 <source> (the .ogv ones: Theora, which browsers dropped)
  bnwmovies: function (query, limit) {
    return page(BNW + '/?s=' + encodeURIComponent(words(query))).then(function (html) {
      return playpex.html.select(html, 'h3 a', { href: '@href', title: '' });
    }).then(function (links) {
      var films = links.filter(function (l) { return /^https:\/\/bnwmovies\.com\/[^/]+\.html$/.test(l.href || ''); }).slice(0, limit || 4);
      return Promise.all(films.map(function (film) {
        return page(film.href).then(function (html) {
          return playpex.html.select(html, 'source', { src: '@src', type: '@type' }).then(function (sources) {
            var title = String(film.title || '').trim(),
              year = (new RegExp('"' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '" \\((\\d{4})\\)').exec(html) || /-(\d{4})\.jpg/.exec(html) || [])[1],
              poster = (/og:image" content="(https:[^"?]+)/.exec(html) || [])[1];
            return sources.filter(function (s) { return /\.mp4(\?|$)/i.test(s.src || ''); }).map(function (s) {
              return {
                title: title, year: year ? Number(year) : undefined, poster: poster,
                url: s.src.replace(/^https:\/\/www\.archive\.org\//, 'https://archive.org/'),
                label: s.src.split('/').pop(), quality: 'SD'
              };
            });
          });
        }, function () { return []; });
      })).then(function (lists) { return [].concat.apply([], lists); });
    });
  },
  // its search API (JSON): each film's Streaming path → <CDN>/<path>.mp4
  netzkino: function (query, limit) {
    return playpex.http.request({
      url: NETZKINO_API + '?q=' + encodeURIComponent(words(query)) + '&d=www&l=de-DE&v=unknown-debugBuild', responseType: 'json', timeoutMs: WAIT_MS
    }).then(function (r) {
      var posts = (r.status === 200 && r.body && r.body.posts) || [];
      return posts.slice(0, limit || 6).map(function (p) {
        var f = p.custom_fields || {},
          path = (f.Streaming || [])[0],
          year = parseInt((f.Jahr || [])[0], 10);
        if (!path || f.drm === true || f.drm === 'true') {
          return null;
        }
        return {
          title: String(p.title || '').slice(0, 200), year: year > 1870 ? year : undefined,
          imdb: ((f['IMDb-Link'] || [])[0] || '').replace(/^.*(tt\d+).*$/, '$1'),
          poster: /^https:/.test((f.Artikelbild || [])[0] || '') ? f.Artikelbild[0] : undefined,
          url: NETZKINO_CDN + path.split('/').map(encodeURIComponent).join('/') + '.mp4',
          label: String(p.title || 'netzkino') + ' (netzkino).mp4', quality: '720p'
        };
      }).filter(Boolean);
    });
  }
};

function searchDirect(query, ctx, limit) {
  return Promise.all(Object.keys(direct).map(function (site) {
    return enabled(site, ctx).then(function (on) {
      return on ? direct[site](query, limit).then(function (list) {
        return list.map(function (f) { return Object.assign({ site: site }, f); });
      }) : [];
    });
  })).then(function (lists) { return settle(lists.map(function (l) { return Promise.resolve(l); })); });
}

function httpSource(f) {
  var s = { kind: 'http', url: f.url, label: f.label.slice(0, 200), container: 'mp4', notes: [f.site === 'netzkino' ? 'From netzkino' : 'From BnW Movies'] };
  if (f.quality) {
    s.quality = f.quality;
  }
  if (f.size) {
    s.size = f.size;
  }
  return s;
}

// ── hooks ───────────────────────────────────────────────────────────────────

/** Torrents as sources, kept only when the core's matcher says they're this title; the 50 best */
function magnetsFor(list, title) {
  if (!list.length) {
    return [];
  }
  return playpex.names.matches(list.map(function (t) { return t.name.slice(0, 1000); }), title).then(function (kinds) {
    var kept = list.filter(function (t, i) { return kinds[i]; });
    var sources = kept.map(function (t) {
      return { kind: 'magnet', infoHash: t.hash, label: t.name.slice(0, 200), size: t.size || undefined, seeds: t.seeds, peers: t.peers };
    });
    if (sources.length <= MAX_SOURCES) {
      return sources;
    }
    return playpex.names.rank(sources.map(function (s, i) { return { name: s.label, seeds: s.seeds, i: i }; })).then(function (order) {
      return order.slice(0, MAX_SOURCES).map(function (o) { return sources[o.i]; });
    });
  });
}

playpex.hooks.on('play.collect', function (input, ctx) {
  var t = input.title, name = words(t.title);
  if (!name) {
    return [];
  }
  if (t.kind === 'episode') {
    var code = 'S' + pad(t.season);
    return settle([
      searchTorrents(name + ' ' + code + 'E' + pad(t.episode), 'show', ctx),
      searchTorrents(name + ' ' + code, 'show', ctx)
    ]).then(function (all) { return magnetsFor(all, t); });
  }
  if (t.kind !== 'movie') {
    return [];
  }
  var files = searchDirect(t.title, ctx, 3).then(function (found) {
    return found.filter(function (f) {
      var same = words(f.title).toLowerCase() === name.toLowerCase();
      return (f.imdb && t.imdbId && f.imdb === t.imdbId) || (same && (!t.year || !f.year || Math.abs(f.year - t.year) <= 1));
    }).map(httpSource);
  });
  var magnets = searchTorrents(name + (t.year ? ' ' + t.year : ''), 'movie', ctx).then(function (all) { return magnetsFor(all, t); });
  return settle([files, magnets]).then(function (all) { return all.slice(0, MAX_SOURCES); });
});

playpex.hooks.on('sources.search', function (input, ctx) {
  if (input.kind === 'show' || input.page > 1) {
    return { results: [], last: true };
  }
  return searchDirect(input.query, ctx, 6).then(function (found) {
    return {
      results: found.map(function (f) {
        var r = { title: f.title, source: httpSource(f) };
        if (f.year >= 1870 && f.year <= 2100) {
          r.year = f.year;
        }
        if (f.poster) {
          r.poster = f.poster;
        }
        return r;
      }),
      last: true
    };
  });
});

playpex.hooks.on('releases.providers', function (input, ctx) {
  if (input.page > 1 || (input.kind !== 'movie' && input.kind !== 'show')) {
    return { releases: [], last: true };
  }
  var query = words(input.query);
  // no keywords: LimeTorrents' category by seeds
  var list = query ? searchTorrents(query, input.kind, ctx) :
    enabled('limetorrents', ctx).then(function (on) {
      return on ? pageFrom(LIME, '/browse-torrents/' + (input.kind === 'movie' ? 'Movies' : 'TV-shows') + '/seeds/1/').then(limeRows) : [];
    });
  return list.then(function (all) {
    return {
      releases: all.slice(0, 500).map(function (t) {
        var out = { title: t.name.slice(0, 300), infoHash: t.hash, seeds: t.seeds, peers: t.peers, size: t.size || 0 };
        if (t.uploadedAt) {
          out.uploadedAt = t.uploadedAt;
        }
        return out;
      }),
      last: true
    };
  });
});
