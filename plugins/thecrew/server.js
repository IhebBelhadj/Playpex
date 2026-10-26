// The Crew (a port of the Kodi add-ons plugin.video.thecrew 3.2.2 and
// script.module.thecrew 3.2.26, GPL-3.0, The Crew: see LICENSE). Of its
// scrapers, the ones that still answer (checked 2026-10-26) and give
// something Playpex plays, each behind a switch, and its debrid services:
//
//   torrents   Torrentio (scrapers/torrentio.py): many sites, by IMDb id, an
//              episode's own file also inside packs (fileIdx, filename)
//              Knaben (scrapers/knaben.py): its JSON search across sites
//   debrid     Real-Debrid, AllDebrid, Premiumize, TorBox (apis/*_api.py,
//              modules/debrid.py, modules/debridcheck.py): a torrent the
//              service already has → its direct HTTPS link (play.resolve)
//
// Cache checks: Premiumize (cache/check) and TorBox (torrents/checkcached)
// say what they have ("Cached on …"). Real-Debrid switched its
// instantAvailability off (error 37, 2024) and AllDebrid removed
// magnet/instant: both answer `tries` and are asked when the torrent is
// picked; one they don't have is removed from the account again at once
// and the torrent plays.
//
// Left out: the direct-stream services (WebStreamr and NuvioStreams now
// answer "deprecated"), scrapers that only link to file hosts (ResolveURL
// turns those into videos), sites behind Cloudflare challenges (1337x,
// YourBittorrent, TorrentQuest), dead or parked ones, the sites the "Torrent
// sites" plugins and OpenScrapers already read, Easynews / Ororo (accounts
// of their own), its catalog, lists and Trakt (Playpex has its own) and its
// adult sites (never in a plugin for everyone).
//
//   play.collect        Torrentio (movie: /stream/movie/<imdb>; episode:
//                       /stream/series/<imdb>:<s>:<e>) and Knaben ("<title>
//                       <year>", "<show> SxxEyy", "<show> Sxx", kept when the
//                       core's matcher says it's the title); the 50 best
//   play.resolve        check: Premiumize / TorBox (cached), Real-Debrid /
//                       AllDebrid (tries); resolve: the services in that
//                       order, the file the source named, else the episode's,
//                       else the largest video
//   releases.providers  Knaben, most seeded first, 50 a page
//   sources.search      Knaben's torrents for keywords (the dashboard's Search)
//   checkAccounts       the dashboard's "Check the accounts"
//
// Runs in the server's sandbox (docs/plugins/server.md). Educational project:
// streaming copyrighted content may be illegal where you live.

var MAX_SOURCES = 50,
  PAGE = 50,
  TORRENTIO = 'https://torrentio.strem.fun',
  KNABEN = 'https://api.knaben.org/v1',
  RD = 'https://api.real-debrid.com/rest/1.0/',
  AD = 'https://api.alldebrid.com/v4/',
  PM = 'https://www.premiumize.me/api/',
  TB = 'https://api.torbox.app/v1/api/',
  KNABEN_MOVIES = 3000000,
  KNABEN_TV = 2000000,
  AGENT = 'playpex',
  // where the services' links may live: this plugin's `network` (a link elsewhere can't play)
  LINK_HOSTS = ['*.real-debrid.com', '*.alldebrid.com', '*.debrid.it', '*.premiumize.me', '*.energycdn.com', '*.torbox.app', '*.tb-cdn.st'],
  VIDEO = /\.(mkv|mp4|m4v|webm|avi|mov|ts|m2ts|wmv|mpg)$/i,
  EXTRA = /(^|[^a-z])(sample|trailer|proof|featurette)s?([^a-z]|$)/i,
  WAIT_MS = 5000,
  // a resolve has 10 s: each service's call gets this, and none starts past BUDGET_MS
  CALL_MS = 4000,
  BUDGET_MS = 7000;

// ── helpers ─────────────────────────────────────────────────────────────────

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

/** Plain words: what every search takes */
function words(text) {
  return String(text || '').replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** "31.23 GB", "925 MB" → bytes */
function bytes(text) {
  var m = /([\d.,]+)\s*([KMGT]i?B)/i.exec(String(text || ''));
  if (!m) {
    return 0;
  }
  var unit = { K: 1, M: 2, G: 3, T: 4 }[m[2][0].toUpperCase()];
  return Math.round(parseFloat(m[1].replace(',', '.')) * Math.pow(1024, unit));
}

function enabled(key, ctx) {
  return playpex.settings.get(key, ctx).then(function (v) { return v !== false; }, function () { return false; });
}

/** application/x-www-form-urlencoded; an array value repeats its key */
function form(fields) {
  var out = [];
  Object.keys(fields).forEach(function (k) {
    [].concat(fields[k]).forEach(function (v) {
      out.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
  });
  return out.join('&');
}

/** A JSON API call; non-2xx answers throw with the service's own words */
function api(name, options) {
  var request = Object.assign({ responseType: 'json', timeoutMs: CALL_MS }, options);
  if (options.form) {
    request.method = request.method || 'POST';
    request.body = form(options.form);
    request.headers = Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, options.headers);
    delete request.form;
  }
  return playpex.http.request(request).then(function (r) {
    if (r.status === 204) {
      return {};
    }
    if (r.status < 200 || r.status > 299) {
      var said = r.body && typeof r.body === 'object' ? (r.body.error && (r.body.error.message || r.body.error)) || r.body.message || r.body.detail : null;
      var err = new Error(name + ': HTTP ' + r.status + (said ? ' (' + String(said).slice(0, 80) + ')' : ''));
      err.status = r.status;
      throw err;
    }
    return r.body || {};
  });
}

/** Each part on its own: one failing never sinks the others */
function settle(list) {
  return Promise.all(list.map(function (p) {
    return p.catch(function (err) {
      playpex.log.warn(err.message);
      return [];
    });
  })).then(function (lists) { return [].concat.apply([], lists); });
}

function chunks(list, size) {
  var out = [];
  for (var i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
}

function baseName(path) {
  return String(path || '').split('/').pop();
}

function hostOf(url) {
  return (/^https?:\/\/([^/:?#]+)/i.exec(url) || [])[1] || '';
}

function linkHostAllowed(url) {
  var host = hostOf(url).toLowerCase();
  return LINK_HOSTS.some(function (p) { return host.length > p.length - 1 && host.slice(-(p.length - 1)) === p.slice(1); });
}

function magnetOf(source) {
  return source.magnet || 'magnet:?xt=urn:btih:' + source.infoHash;
}

// ── torrents ────────────────────────────────────────────────────────────────

/** Torrentio's streams of a title: [{ name, hash, size, seeds, site, fileIndex?, fileName? }] */
function torrentio(t) {
  if (!t.imdbId) {
    return Promise.resolve([]);
  }
  var path = t.kind === 'episode' ? '/stream/series/' + t.imdbId + ':' + t.season + ':' + t.episode + '.json' : '/stream/movie/' + t.imdbId + '.json';
  return api('Torrentio', { url: TORRENTIO + path, timeoutMs: 7000 }).then(function (body) {
    return (body.streams || []).filter(function (s) { return /^[0-9a-f]{40}$/i.test(s.infoHash || ''); }).map(function (s) {
      // "<torrent name>\n<file name, in a pack>\n👤 129 💾 31.23 GB ⚙️ ThePirateBay"
      var lines = String(s.title || '').split('\n'),
        info = lines.filter(function (l) { return l.indexOf('👤') !== -1; })[0] || '',
        hints = s.behaviorHints || {};
      return {
        name: lines[0].trim() || hints.filename || s.infoHash,
        hash: s.infoHash.toLowerCase(),
        seeds: parseInt((/👤\s*(\d+)/.exec(info) || [])[1], 10) || 0,
        size: bytes((/💾\s*([\d.,]+\s*[KMGT]i?B)/.exec(info) || [])[1]),
        site: ((/⚙️\s*(.+)$/.exec(info) || [])[1] || '').trim(),
        fileIndex: typeof s.fileIdx === 'number' ? s.fileIdx : undefined,
        fileName: hints.filename || undefined
      };
    });
  });
}

/** Knaben's search: [{ name, hash, size, seeds, peers, site, uploadedAt? }] */
function knaben(query, kind, page) {
  var ask = {
    order_by: 'seeders', order_direction: 'desc', size: PAGE, from: ((page || 1) - 1) * PAGE,
    hide_unsafe: true, hide_xxx: true
  };
  if (query) {
    ask.search_type = '100%';
    ask.search_field = 'title';
    ask.query = query;
  }
  if (kind === 'movie' || kind === 'show') {
    ask.categories = [kind === 'movie' ? KNABEN_MOVIES : KNABEN_TV];
  }
  return api('Knaben', { url: KNABEN, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ask, timeoutMs: WAIT_MS }).then(function (body) {
    return (body.hits || []).filter(function (h) { return /^[0-9a-f]{40}$/i.test(h.hash || '') && h.title; }).map(function (h) {
      var out = {
        name: String(h.title).trim(), hash: h.hash.toLowerCase(), size: Number(h.bytes) || 0,
        seeds: Number(h.seeders) || 0, peers: Number(h.peers) || 0, site: String(h.cachedOrigin || '').replace(/\s*\(proxy\)$/, '')
      };
      if (h.date && !isNaN(Date.parse(h.date))) {
        out.uploadedAt = new Date(h.date).toISOString();
      }
      return out;
    });
  });
}

function knabenFor(t, ctx) {
  return enabled('knaben', ctx).then(function (on) {
    if (!on) {
      return [];
    }
    var name = words(t.title);
    var asked = t.kind === 'episode' ?
      [knaben(name + ' S' + pad(t.season) + 'E' + pad(t.episode), 'show'), knaben(name + ' S' + pad(t.season), 'show')] :
      [knaben(name + (t.year ? ' ' + t.year : ''), 'movie')];
    return settle(asked).then(function (all) {
      if (!all.length) {
        return [];
      }
      // a keyword search finds other titles too ("The Bad Guys Breaking In"): the core's matcher decides
      return playpex.names.matches(all.map(function (r) { return r.name.slice(0, 1000); }), t).then(function (kinds) {
        return all.filter(function (r, i) { return kinds[i]; });
      });
    });
  });
}

function magnetSource(r, from) {
  var s = { kind: 'magnet', infoHash: r.hash, label: r.name.slice(0, 200), seeds: r.seeds, notes: [('From ' + from + (r.site ? ' (' + r.site + ')' : '')).slice(0, 80)] };
  if (r.size) {
    s.size = r.size;
  }
  if (r.peers) {
    s.peers = r.peers;
  }
  if (r.fileIndex != null) {
    s.fileIndex = r.fileIndex;
  }
  if (r.fileName) {
    s.fileName = String(r.fileName).slice(0, 500);
  }
  return s;
}

// ── debrid services ─────────────────────────────────────────────────────────

function keys() {
  return Promise.all(['realdebridToken', 'alldebridKey', 'premiumizeKey', 'torboxKey'].map(function (k) {
    return playpex.secrets.get(k).then(function (v) { return v ? String(v).trim() : ''; }, function () { return ''; });
  })).then(function (v) {
    return { realdebrid: v[0], alldebrid: v[1], premiumize: v[2], torbox: v[3] };
  });
}

/**
 * The file to play among a torrent's ([{ name (its path), size, … }]): the one
 * the source named, else the episode's (the core's matcher, then SxxEyy /
 * NxNN), else the largest video that isn't an extra; null: none fits.
 */
function pickFile(files, title, source) {
  var videos = files.filter(function (f) { return VIDEO.test(f.name) && !EXTRA.test(baseName(f.name)); });
  if (!videos.length) {
    return Promise.resolve(null);
  }
  var named = source.fileName && videos.filter(function (f) { return baseName(f.name).toLowerCase() === baseName(source.fileName).toLowerCase(); })[0];
  if (named) {
    return Promise.resolve(named);
  }
  var largest = videos.slice().sort(function (a, b) { return (b.size || 0) - (a.size || 0); });
  if (title.kind !== 'episode') {
    return Promise.resolve(largest[0]);
  }
  return playpex.names.matches(largest.map(function (f) { return baseName(f.name).slice(0, 1000); }), title).then(function (kinds) {
    var hit = largest.filter(function (f, i) { return kinds[i] === 'episode'; })[0];
    if (hit) {
      return hit;
    }
    return largest.filter(function (f) {
      var n = baseName(f.name), m = /s(\d{1,2})[ ._-]*e(\d{1,3})/i.exec(n) || /(?:^|[^\d])(\d{1,2})x(\d{2,3})(?:[^\d]|$)/.exec(n);
      return m && Number(m[1]) === title.season && Number(m[2]) === title.episode;
    })[0] || (videos.length === 1 ? videos[0] : null);
  });
}

function httpSource(url, file, service) {
  if (!linkHostAllowed(url)) {
    playpex.log.warn(service + ' gave a link on ' + hostOf(url) + ', a host this plugin may not reach');
    return null;
  }
  var s = { kind: 'http', url: url, label: baseName(file.name).slice(0, 200) || service };
  var ext = (/\.([a-z0-9]{2,4})$/i.exec(file.name) || [])[1];
  if (file.size) {
    s.size = Math.round(file.size);
  }
  if (ext) {
    s.container = ext.toLowerCase();
  }
  return s;
}

var services = {
  // Bearer token; addMagnet → selectFiles(the file) → downloaded at once when Real-Debrid has it → unrestrict its link
  realdebrid: {
    name: 'Real-Debrid',
    check: null,
    resolve: function (key, title, source) {
      var auth = { Authorization: 'Bearer ' + key }, id = null;
      function call(path, options) {
        return api('Real-Debrid', Object.assign({ url: RD + path, headers: auth }, options));
      }
      function drop() {
        return id ? call('torrents/delete/' + id, { method: 'DELETE' }).catch(function () {}) : Promise.resolve();
      }
      return call('torrents/addMagnet', { form: { magnet: magnetOf(source) } }).then(function (added) {
        id = added.id;
        return call('torrents/info/' + id);
      }).then(function (info) {
        var files = (info.files || []).map(function (f) { return { id: f.id, name: f.path, size: f.bytes }; });
        return pickFile(files, title, source).then(function (file) {
          if (!file) {
            return null;
          }
          return call('torrents/selectFiles/' + id, { form: { files: String(file.id) } }).then(function () {
            return call('torrents/info/' + id);
          }).then(function (done) {
            if (done.status !== 'downloaded' || !(done.links || []).length) {
              return null;   // not on Real-Debrid: it would start downloading it in the account
            }
            return call('unrestrict/link', { form: { link: done.links[0] } }).then(function (u) {
              return u.download ? httpSource(u.download, { name: u.filename || file.name, size: u.filesize || file.size }, 'Real-Debrid') : null;
            });
          });
        });
      }).then(function (played) {
        return played ? played : drop().then(function () { return null; });
      }, function (err) {
        return drop().then(function () { throw err; });
      });
    },
    account: function (key) {
      return api('Real-Debrid', { url: RD + 'user', headers: { Authorization: 'Bearer ' + key } }).then(function (u) {
        return u.type === 'premium' ? 'premium' + (u.expiration ? ' until ' + String(u.expiration).slice(0, 10) : '') : 'not premium';
      });
    }
  },
  // agent + apikey; magnet/upload says `ready` (cached) → magnet/files (a tree) → link/unlock
  alldebrid: {
    name: 'AllDebrid',
    check: null,
    resolve: function (key, title, source) {
      var id = null;
      function call(path, fields) {
        return api('AllDebrid', { url: AD + path + '?agent=' + AGENT + '&apikey=' + encodeURIComponent(key), form: fields }).then(function (body) {
          if (body.status !== 'success') {
            throw new Error('AllDebrid: ' + ((body.error && body.error.message) || 'failed'));
          }
          return body.data || {};
        });
      }
      function drop() {
        return id ? call('magnet/delete', { id: String(id) }).catch(function () {}) : Promise.resolve();
      }
      function flatten(nodes, path, out) {
        (nodes || []).forEach(function (n) {
          if (n.e) {
            flatten(n.e, path + n.n + '/', out);
          } else if (n.l) {
            out.push({ name: path + n.n, size: n.s, link: n.l });
          }
        });
        return out;
      }
      return call('magnet/upload', { 'magnets[]': magnetOf(source) }).then(function (data) {
        var m = (data.magnets || [])[0] || {};
        id = m.id;
        if (!m.ready) {
          return null;
        }
        return call('magnet/files', { 'id[]': String(id) }).then(function (data) {
          var files = flatten(((data.magnets || [])[0] || {}).files, '', []);
          return pickFile(files, title, source).then(function (file) {
            return file ? call('link/unlock', { link: file.link }).then(function (u) {
              return u.link ? httpSource(u.link, { name: u.filename || file.name, size: u.filesize || file.size }, 'AllDebrid') : null;
            }) : null;
          });
        });
      }).then(function (played) {
        return played ? played : drop().then(function () { return null; });
      }, function (err) {
        return drop().then(function () { throw err; });
      });
    },
    account: function (key) {
      return api('AllDebrid', { url: AD + 'user?agent=' + AGENT + '&apikey=' + encodeURIComponent(key) }).then(function (body) {
        var u = (body.data || {}).user || {};
        if (body.status !== 'success') {
          var err = new Error('AllDebrid: ' + ((body.error && body.error.message) || 'failed'));
          err.status = /^AUTH_/.test((body.error && body.error.code) || '') ? 401 : 0;
          throw err;
        }
        return u.isPremium ? 'premium' : 'not premium';
      });
    }
  },
  // apikey; cache/check (100 a call) → transfer/directdl gives every file's link at once
  premiumize: {
    name: 'Premiumize',
    check: function (key, hashes) {
      return Promise.all(chunks(hashes, 100).map(function (part) {
        return api('Premiumize', { url: PM + 'cache/check?apikey=' + encodeURIComponent(key) + '&' + form({ 'items[]': part }), timeoutMs: 2500 }).then(function (body) {
          return part.filter(function (h, i) { return body.status === 'success' && (body.response || [])[i] === true; });
        });
      })).then(function (lists) { return [].concat.apply([], lists); });
    },
    resolve: function (key, title, source) {
      return api('Premiumize', { url: PM + 'transfer/directdl?apikey=' + encodeURIComponent(key), form: { src: magnetOf(source) } }).then(function (body) {
        if (body.status !== 'success') {
          return null;
        }
        var files = (body.content || []).map(function (c) { return { name: c.path || '', size: Number(c.size) || 0, link: c.link }; });
        return pickFile(files, title, source).then(function (file) {
          return file && file.link ? httpSource(file.link, file, 'Premiumize') : null;
        });
      });
    },
    account: function (key) {
      return api('Premiumize', { url: PM + 'account/info?apikey=' + encodeURIComponent(key) }).then(function (body) {
        if (body.status !== 'success') {
          throw new Error('Premiumize: ' + (body.message || 'failed'));
        }
        return body.premium_until ? 'premium until ' + new Date(body.premium_until * 1000).toISOString().slice(0, 10) : 'not premium';
      });
    }
  },
  // Bearer key; torrents/checkcached (100 a call) → createtorrent → mylist (its files) → requestdl
  torbox: {
    name: 'TorBox',
    check: function (key, hashes) {
      return Promise.all(chunks(hashes, 100).map(function (part) {
        return api('TorBox', {
          url: TB + 'torrents/checkcached?hash=' + part.join(',') + '&format=object&list_files=false',
          headers: { Authorization: 'Bearer ' + key }, timeoutMs: 2500
        }).then(function (body) {
          var have = body.data || {};
          return part.filter(function (h) { return have[h] || have[h.toUpperCase()]; });
        });
      })).then(function (lists) { return [].concat.apply([], lists); });
    },
    resolve: function (key, title, source) {
      var auth = { Authorization: 'Bearer ' + key }, id = null;
      return api('TorBox', { url: TB + 'torrents/createtorrent', headers: auth, form: { magnet: magnetOf(source) } }).then(function (body) {
        id = body.data && body.data.torrent_id;
        if (!id) {
          return null;
        }
        return api('TorBox', { url: TB + 'torrents/mylist?id=' + id + '&bypass_cache=true', headers: auth }).then(function (body) {
          var t = body.data || {};
          if (!t.download_present && !t.download_finished) {
            return null;
          }
          var files = (t.files || []).map(function (f) { return { id: f.id, name: f.name || f.short_name || '', size: f.size }; });
          return pickFile(files, title, source).then(function (file) {
            if (!file) {
              return null;
            }
            return api('TorBox', {
              url: TB + 'torrents/requestdl?token=' + encodeURIComponent(key) + '&torrent_id=' + id + '&file_id=' + file.id + '&zip_link=false',
              headers: auth
            }).then(function (body) {
              return typeof body.data === 'string' ? httpSource(body.data, file, 'TorBox') : null;
            });
          });
        });
      });
    },
    account: function (key) {
      return api('TorBox', { url: TB + 'user/me', headers: { Authorization: 'Bearer ' + key } }).then(function (body) {
        var u = body.data || {};
        return u.plan ? 'plan ' + u.plan + (u.premium_expires_at ? ' until ' + String(u.premium_expires_at).slice(0, 10) : '') : 'free';
      });
    }
  }
};

// the order resolvers are asked in: the ones that tell, then the ones that only try
var ORDER = ['torbox', 'premiumize', 'realdebrid', 'alldebrid'],
  // hash → the services whose check said they have it (the last checks; ≤ 2000)
  cachedOn = new Map();

function remember(hash, id) {
  var list = cachedOn.get(hash) || [];
  if (list.indexOf(id) === -1) {
    list.push(id);
  }
  cachedOn.delete(hash);
  cachedOn.set(hash, list);
  if (cachedOn.size > 2000) {
    cachedOn.delete(cachedOn.keys().next().value);
  }
}

function check(hashes) {
  return keys().then(function (k) {
    var telling = ORDER.filter(function (id) { return k[id] && services[id].check; }),
      trying = ORDER.filter(function (id) { return k[id] && !services[id].check; }),
      out = {};
    return Promise.all(telling.map(function (id) {
      return services[id].check(k[id], hashes).then(function (have) {
        have.forEach(function (h) { remember(h, id); });
        return { id: id, have: have };
      }, function (err) {
        playpex.log.warn(err.message);
        return { id: id, have: [] };
      });
    })).then(function (answers) {
      hashes.forEach(function (h) {
        // the first service in ORDER that has it names the badge
        var by = answers.filter(function (a) { return a.have.indexOf(h) !== -1; })[0];
        if (by) {
          out[h] = { cached: true, label: services[by.id].name };
        } else if (trying.length) {
          out[h] = { cached: false, tries: true, label: trying.map(function (id) { return services[id].name; }).join(' or ').slice(0, 40) };
        }
      });
      return { hashes: out };
    });
  });
}

function resolve(title, source) {
  var started = Date.now(), hash = String(source.infoHash || (/btih:([0-9a-f]{40})/i.exec(source.magnet || '') || [])[1] || '').toLowerCase();
  return keys().then(function (k) {
    var have = cachedOn.get(hash) || [],
      // a check that said cached first; the services that can't tell after; the others last (a check older than this run)
      order = have.concat(ORDER.filter(function (id) { return have.indexOf(id) === -1 && !services[id].check; }))
        .concat(ORDER.filter(function (id) { return have.indexOf(id) === -1 && services[id].check; }))
        .filter(function (id) { return k[id]; });
    var i = 0;
    function next() {
      if (i >= order.length || Date.now() - started > BUDGET_MS) {
        return null;
      }
      var id = order[i++];
      return services[id].resolve(k[id], title, source).then(function (played) {
        if (played) {
          played.notes = ['From ' + services[id].name];
          return played;
        }
        return next();
      }, function (err) {
        playpex.log.warn(err.message);
        return next();
      });
    }
    return next();
  }).then(function (played) {
    return { source: played || null };
  });
}

// ── hooks ───────────────────────────────────────────────────────────────────

playpex.hooks.on('play.collect', function (input, ctx) {
  var t = input.title;
  if ((t.kind !== 'movie' && t.kind !== 'episode') || !words(t.title)) {
    return [];
  }
  var fromTorrentio = enabled('torrentio', ctx).then(function (on) {
    return on ? torrentio(t).then(function (list) { return list.map(function (r) { return magnetSource(r, 'Torrentio'); }); }) : [];
  });
  var fromKnaben = knabenFor(t, ctx).then(function (list) { return list.map(function (r) { return magnetSource(r, 'Knaben'); }); });
  return settle([fromTorrentio, fromKnaben]).then(function (all) {
    // one per hash: Torrentio's first (it names the file), the better seeded otherwise
    var byHash = {};
    all.forEach(function (s) {
      var had = byHash[s.infoHash];
      if (!had || (!had.fileName && s.fileName) || (!!had.fileName === !!s.fileName && s.seeds > had.seeds)) {
        byHash[s.infoHash] = s;
      }
    });
    var sources = Object.keys(byHash).map(function (h) { return byHash[h]; });
    if (sources.length <= MAX_SOURCES) {
      return sources;
    }
    return playpex.names.rank(sources.map(function (s, i) { return { name: s.label, seeds: s.seeds, i: i }; })).then(function (order) {
      return order.slice(0, MAX_SOURCES).map(function (o) { return sources[o.i]; });
    });
  });
});

playpex.hooks.on('play.resolve', function (input) {
  return input.mode === 'check' ? check(input.hashes) : resolve(input.title, input.source);
});

playpex.hooks.on('releases.providers', function (input, ctx) {
  var query = words(input.query);
  // a show's own torrents (by its IMDb id): Knaben only searches names
  if ((input.kind !== 'movie' && input.kind !== 'show') || (input.title && !query)) {
    return { releases: [], last: true };
  }
  return enabled('knaben', ctx).then(function (on) {
    return on ? knaben(query, input.kind, input.page) : [];
  }).then(function (all) {
    return {
      releases: all.map(function (r) {
        var out = { title: r.name.slice(0, 300), infoHash: r.hash, seeds: r.seeds, peers: r.peers, size: r.size };
        if (r.uploadedAt) {
          out.uploadedAt = r.uploadedAt;
        }
        return out;
      }),
      last: all.length < PAGE
    };
  });
});

playpex.hooks.on('sources.search', function (input, ctx) {
  return enabled('knaben', ctx).then(function (on) {
    return on ? knaben(words(input.query), input.kind, input.page) : [];
  }).then(function (all) {
    return {
      results: all.map(function (r) { return { source: magnetSource(r, 'Knaben') }; }),
      last: all.length < PAGE
    };
  });
});

// the dashboard's "Check the accounts": each service's answer in one toast
playpex.data('checkAccounts', function () {
  return keys().then(function (k) {
    var set = ORDER.filter(function (id) { return k[id]; });
    if (!set.length) {
      return { effects: [{ type: 'toast', tone: 'info', text: 'No debrid account yet: enter a token or key above, then save.' }] };
    }
    return Promise.all(set.map(function (id) {
      return services[id].account(k[id]).then(function (state) {
        return { ok: true, name: services[id].name, text: services[id].name + ': ' + state };
      }, function (err) {
        return { ok: false, name: services[id].name, text: services[id].name + ': ' + (err.status === 401 || err.status === 403 ? 'the key was refused' : 'no answer') };
      });
    })).then(function (said) {
      var failed = said.filter(function (s) { return !s.ok; }),
        fine = said.filter(function (s) { return s.ok; });
      // a toast holds 120 characters: what failed in full, the rest by name
      var text = failed.length ? failed.map(function (s) { return s.text; }).join('; ') + '.' +
        (fine.length ? ' ' + fine.map(function (s) { return s.name; }).join(', ') + ': fine' : '') :
        said.map(function (s) { return s.text; }).join('; ');
      return { effects: [{ type: 'toast', tone: failed.length ? 'error' : 'success', text: text.slice(0, 120) }] };
    });
  });
});
