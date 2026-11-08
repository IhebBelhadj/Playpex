// Velvet: a film section as a plugin. Runs in the server's sandbox
// (docs/plugins/server.md); the TV draws it with the core's templates.
// Educational project: streaming copyrighted content via torrents may be
// illegal where you live.
//
// Data handlers and what the core sends them:
//   browse    catalog   { params, query, filters: { view, kind, studio, period } } the poster layout (films, scenes)
//   rowPage   row page  { page, provider, row?, sort?, studio?, period?, q? }  a paged row
//   title     title     { params: { provider, id } }                          one title
//   play      call      { provider, id }                                     its streams and torrents → the core's player
//   releases  releases  { params: { q? }, query, filters, page }             the list layout (screens releases, find)
//   searchFilter        { slot, context: { query } }                         the search page's chip: films, scenes, and Releases (the find screen)
//
// The layout (posters or list) is the "View" filter of both screens, kept per
// profile in the store: the section opens the profile's last one. Films from
// TMDB (through studios) or a second metadata provider, the profile's choice;
// scenes (studios' web releases, small studios included) from the second one,
// its `/scenes` and `/sites`, with the studios the profile follows (setting
// `sceneStudios`) as rows; releases from two torrent indexes' categories, most
// seeded first, a scene's matched by its studio and date, performer or title.
// Full films also stream from Sex-Empire (setting sexEmpire, on by default):
// a row of its newest films and its search (provider `sexempire`, the site's
// film number as the id), and a catalog film's Play adds its streams (VidHide
// HLS, DoodStream MP4) before the torrents when the site has the same film.
// Studios' videos (Ersties, Lustery, Playboy Plus) come from TheSexTube

var TMDB = "https://api.themoviedb.org/3";
var TMDB_IMG = "https://image.tmdb.org/t/p/";
var TPDB = "https://api.theporndb.net";
var APIBAY = "https://apibay.org";
var THERARBG = ["https://therarbg.to", "https://therarbg.com"];
var TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
];
var CACHE_MS = 60 * 60 * 1000;
var PAGE_SIZE = 20;
var MAX_PAGE = 500; // TMDB answers no page past 500

// ── small helpers ───────────────────────────────────────────────────────────

function qs(params) {
  return Object.keys(params)
    .filter(function(k) {
      return params[k] !== undefined && params[k] !== null && params[k] !== "";
    })
    .map(function(k) {
      return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
    })
    .join("&");
}

var cache = {};

/** A GET answer as JSON, cached an hour (failures aren't kept) */
function getJson(url, headers) {
  var hit = cache[url];
  if (hit && hit.expires > Date.now()) {
    return hit.value;
  }
  var value = playpex.http
    .request({ url: url, responseType: "json", headers: headers || {} })
    .then(function(res) {
      if (res.status !== 200) {
        throw new Error(url.split("?")[0] + " answered HTTP " + res.status);
      }
      return res.body;
    });
  cache[url] = { value: value, expires: Date.now() + CACHE_MS };
  value.catch(function() {
    delete cache[url];
  });
  return value;
}

/** The first mirror that answers */
function mirrored(bases, path) {
  var i = 0;
  function attempt() {
    return getJson(bases[i] + path).catch(function(err) {
      if (++i < bases.length) {
        return attempt();
      }
      throw err;
    });
  }
  return attempt();
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function magnetOf(hash, name) {
  return (
    "magnet:?xt=urn:btih:" +
    hash +
    "&dn=" +
    encodeURIComponent(name) +
    TRACKERS.map(function(t) {
      return "&tr=" + encodeURIComponent(t);
    }).join("")
  );
}

function clip(text, n) {
  text = String(text || "");
  return text.length > n ? text.slice(0, n - 1) + "…" : text;
}

// ── release names ───────────────────────────────────────────────────────────

// "Some Title Vol. 2 [Studio 2026] WEB-DL 1080p MP4-P2P" →
// title "Some Title Vol. 2", studio "Studio", year 2026
var JUNK =
  /\b(xxx|2160p|1080p|720p|480p|4k|uhd|web.?dl|webrip|hdrip|bluray|dvdrip|split.?scenes?|mp4|mkv|wmv|x26[45]|h\.?26[45]|hevc|p2p|[-.](xc|trb|ktr|gush|wrb|nbq|xleech))\b/i;

function present(name) {
  var text = String(name)
    .replace(/\.(mp4|mkv|avi|wmv)$/i, "")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  var studio = null,
    year = null;
  var bracket = text.match(/\[([^\]]+?)\s+((19|20)\d\d)\]/);
  if (bracket) {
    studio = bracket[1].trim();
    year = Number(bracket[2]);
  }
  var title = text.replace(/\[[^\]]*\]/g, " ");
  var junk = title.search(JUNK);
  if (junk > 0) {
    title = title.slice(0, junk);
  }
  title = title
    .replace(/[\s\-–(]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return { title: title.length < 3 ? text : title, studio: studio, year: year };
}

// What plays in the TV's Chromium (as the core's episodes.js says it)
function describe(name) {
  var resolution = (name.match(/\b(2160p|1080p|720p|480p)\b/i) || [])[1];
  if (!resolution && /\b(4k|uhd)\b/i.test(name)) {
    resolution = "2160p";
  }
  resolution = resolution ? resolution.toLowerCase() : "SD";
  var hevc = /\b(x265|h\.?265|hevc)\b/i.test(name),
    tenBit = /\b10.?bit\b/i.test(name),
    xvid = /\b(xvid|divx)\b/i.test(name),
    audio = "unknown";
  if (
    /\b(ddp?\s?\d|ddp|dd\+|e-?ac-?3|ac-?3|eac3|truehd|atmos|dts(-?hd)?)\b/i.test(
      name,
    )
  ) {
    audio = "unsupported";
  } else if (/\b(aac|opus|mp3)/i.test(name)) {
    audio = "supported";
  }
  return {
    quality: resolution,
    codec: hevc ? "x265" : xvid ? "xvid" : "x264",
    audio: audio,
    playable: !hevc && !tenBit && !xvid && resolution !== "2160p",
    scenes: /\bsplit.?scenes?\b/i.test(name),
  };
}

function normalizeTitle(text) {
  return String(text)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// null when the release isn't this film, else { yearMatch }: the name starts
// with the title (after a "[Studio]" tag), not followed by a sequel number; a
// release stating another year is another film
function match(name, title, year) {
  var normalized = normalizeTitle(
    String(name).replace(/^\s*(\[[^\]]*\]|\([^)]*\)|\s)+/, ""),
  ),
    wanted = normalizeTitle(title);
  if (!wanted) {
    return null;
  }
  var found = new RegExp(
    "^" +
    escapeRegExp(wanted).replace(/ /g, " +") +
    "(?= |$)(?! +([2-9]|[1-9]\\d)( |$))",
  ).test(normalized);
  if (!found) {
    return null;
  }
  var yearMatch = false,
    years = normalized.slice(wanted.length).match(/\b(19|20)\d\d\b/g) || [];
  if (year && years.length) {
    yearMatch = years.some(function(y) {
      return Math.abs(Number(y) - year) <= 1;
    });
    if (!yearMatch) {
      return null;
    }
  }
  return { yearMatch: yearMatch };
}

var AUDIO_RANK = { supported: 2, unknown: 1, unsupported: 0 },
  RESOLUTION_RANK = { "1080p": 3, "720p": 2, "480p": 1, SD: 1, "2160p": 0 },
  HEALTHY_SEEDS = 10;

function compare(a, b) {
  return (
    b.playable - a.playable ||
    AUDIO_RANK[b.audio] - AUDIO_RANK[a.audio] ||
    (b.seeds >= HEALTHY_SEEDS) - (a.seeds >= HEALTHY_SEEDS) ||
    a.scenes - b.scenes ||
    b.yearMatch - a.yearMatch ||
    (RESOLUTION_RANK[b.quality] || 0) - (RESOLUTION_RANK[a.quality] || 0) ||
    b.seeds - a.seeds
  );
}

// ── torrent sources (categories) ──────────────────────────────────────────────

// The index's subcategories that hold films (not DVDR images, pictures, games)
var PIRATEBAY_FILMS = ["501", "505", "506", "507"];

// Names come HTML-escaped ("Laurent Sky &amp; Julia Grandi", "that&rsquo;s")
var ENTITIES = {
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  hellip: "…",
  ndash: "–",
  mdash: "—",
  eacute: "é",
  egrave: "è",
  aacute: "á",
  agrave: "à",
  ouml: "ö",
  uuml: "ü",
  auml: "ä",
  ccedil: "ç",
  ntilde: "ñ",
};

function unescapeHtml(text) {
  return String(text).replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    function(all, e) {
      if (e[0] === "#") {
        var code =
          e[1] === "x" || e[1] === "X"
            ? parseInt(e.slice(2), 16)
            : parseInt(e.slice(1), 10);
        return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
      }
      return e.toLowerCase() === "amp" ? "&" : ENTITIES[e.toLowerCase()] || all;
    },
  );
}

function words(text) {
  return String(text || "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fromPirateBay(r) {
  var hash = r.info_hash.toLowerCase(),
    name = unescapeHtml(r.name);
  return {
    provider: "The Pirate Bay",
    name: name,
    hash: hash,
    seeds: Number(r.seeders) || 0,
    peers: Number(r.leechers) || 0,
    size: Number(r.size) || 0,
    added: Number(r.added) || 0,
  };
}

/** Its films: the top 100 of `category` (no keywords) or a search (≤ 100); no paging */
function pirateBay(keywords, category) {
  var q = words(keywords);
  var path = q
    ? "/q.php?" + qs({ q: q, cat: category })
    : "/precompiled/data_top100_" + category + ".json";
  return getJson(APIBAY + path).then(function(list) {
    var seen = {};
    return {
      results: (Array.isArray(list) ? list : [])
        .filter(function(r) {
          if (
            !r.info_hash ||
            /^0+$/.test(r.info_hash) ||
            PIRATEBAY_FILMS.indexOf(String(r.category)) === -1 ||
            seen[r.info_hash]
          ) {
            return false;
          }
          seen[r.info_hash] = true;
          return true;
        })
        .map(fromPirateBay),
      hasMore: false,
    };
  });
}

/** TheRARBG's category, most seeded first, 50 a page (never the resolution in the keywords: it then ranks by name) */
function theRarbg(keywords, page) {
  var filters = "order:-se:category:XXX",
    q = words(keywords);
  if (q) {
    filters = "keywords:" + encodeURIComponent(q) + ":" + filters;
  }
  return mirrored(
    THERARBG,
    "/get-posts/" +
    filters +
    "/?" +
    qs({ format: "json", page: page > 1 ? page : null }),
  ).then(function(data) {
    if (!data || !Array.isArray(data.results)) {
      throw new Error("TheRARBG: unexpected answer");
    }
    return {
      results: data.results
        .filter(function(r) {
          return r.h && r.c === "XXX";
        })
        .map(function(r) {
          return {
            provider: "TheRARBG",
            name: r.n,
            hash: r.h.toLowerCase(),
            seeds: Number(r.se) || 0,
            peers: Number(r.le) || 0,
            size: Number(r.s) || 0,
            added: Number(r.a) || 0,
          };
        }),
      hasMore: !!(data.links && data.links.next),
    };
  });
}

var SOURCES = [
  {
    id: "piratebay",
    name: "The Pirate Bay",
    paged: false,
    list: function(c) {
      // its own subcategories narrow the top 100 by resolution
      var category =
        c.quality === "2160p"
          ? "507"
          : c.quality === "1080p" || c.quality === "720p"
            ? "505"
            : "500";
      return pirateBay(c.q, category);
    },
  },
  {
    id: "therarbg",
    name: "TheRARBG",
    paged: true,
    list: function(c) {
      return theRarbg(c.q, c.page);
    },
  },
];

/** Both sources' answers for keywords: [{ provider, name, hash, seeds, size }], and the errors */
function searchSources(keywords) {
  var q = words(keywords);
  var reads = [
    getJson(APIBAY + "/q.php?" + qs({ q: q, cat: "500" })).then(
      function(list) {
        return (Array.isArray(list) ? list : [])
          .filter(function(r) {
            return (
              r.info_hash &&
              !/^0+$/.test(r.info_hash) &&
              PIRATEBAY_FILMS.indexOf(String(r.category)) !== -1
            );
          })
          .map(fromPirateBay);
      },
    ),
    mirrored(
      THERARBG,
      "/get-posts/keywords:" +
      encodeURIComponent(q) +
      ":category:XXX/?format=json",
    ).then(function(data) {
      return ((data && data.results) || [])
        .filter(function(r) {
          return r.h && r.c === "XXX";
        })
        .map(function(r) {
          return {
            provider: "TheRARBG",
            name: r.n,
            hash: r.h.toLowerCase(),
            seeds: Number(r.se) || 0,
            size: Number(r.s) || 0,
          };
        });
    }),
  ];
  return Promise.all(
    reads.map(function(p) {
      return p.then(
        function(v) {
          return { ok: v };
        },
        function(err) {
          return { error: err.message };
        },
      );
    }),
  );
}

/**
 * Torrents for several searches, kept by `matcher(name)` (null: not it, else what
 * it matched, merged into the torrent), one per hash, ranked for streaming
 */
function collectTorrents(searches, matcher) {
  return Promise.all(searches.map(searchSources)).then(function(all) {
    var byHash = {},
      errors = [],
      reads = 0;
    all.forEach(function(results) {
      results.forEach(function(r) {
        reads++;
        if (r.error) {
          errors.push(r.error);
          return;
        }
        r.ok.forEach(function(t) {
          var found = matcher(t.name);
          if (found && (!byHash[t.hash] || t.seeds > byHash[t.hash].seeds)) {
            byHash[t.hash] = Object.assign(t, describe(t.name), found);
          }
        });
      });
    });
    if (errors.length) {
      playpex.log.warn("torrent search errors: " + errors.join("; "));
    }
    var list = Object.keys(byHash).map(function(h) {
      return byHash[h];
    });
    list.sort(compare);
    return { torrents: list, failed: errors.length === reads };
  });
}

/** One film's torrents from both sources, matched by title (+ year) and ranked for streaming */
function findTorrents(title, year) {
  return collectTorrents([title], function(name) {
    return match(name, title, year);
  });
}

// ── scenes' releases ────────────────────────────────────────────────────────

function compact(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** "2024-03-15" → { yy: '24', mm: '03', dd: '15', yyyy: '2024' } */
function dateParts(date) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || ""));
  return m ? { yyyy: m[1], yy: m[1].slice(2), mm: m[2], dd: m[3] } : null;
}

/**
 * Whether a release is this scene: scene releases are named by studio and date
 * ("Studio.24.03.15.Performer.Title.XXX.1080p"), sometimes by studio and
 * performer or title. The studio must be in the name; then its date, one of its
 * performers or most of its title's words. null when it isn't, else
 * { yearMatch: the date matched } (ranked first)
 */
function sceneMatch(name, scene) {
  var n = compact(name),
    studio = scene.studio || {};
  var names = [studio.name, studio.short].map(compact).filter(function(x) {
    return x.length >= 3;
  });
  if (
    !names.some(function(x) {
      return n.indexOf(x) !== -1;
    })
  ) {
    return null;
  }
  var d = dateParts(scene.releaseDate),
    date =
      !!d &&
      (n.indexOf(d.yy + d.mm + d.dd) !== -1 ||
        n.indexOf(d.yyyy + d.mm + d.dd) !== -1),
    performer = (scene.performers || []).some(function(p) {
      var c = compact(p.name);
      return c.length >= 5 && n.indexOf(c) !== -1;
    }),
    titleWords = normalizeTitle(scene.title)
      .split(" ")
      .filter(function(w) {
        return w.length >= 4;
      }),
    nameWords = normalizeTitle(name).split(" "),
    title =
      titleWords.length > 0 &&
      titleWords.filter(function(w) {
        return nameWords.indexOf(w) !== -1;
      }).length /
      titleWords.length >=
      0.6;
  return date || performer || title ? { yearMatch: date } : null;
}

/** The searches that find a scene's releases: studio + date, studio + performer, studio + title */
function sceneSearches(scene) {
  var studio = scene.studio ? scene.studio.name : "",
    d = dateParts(scene.releaseDate),
    list = [];
  if (!studio) {
    return [scene.title];
  }
  if (d) list.push(studio + " " + d.yy + " " + d.mm + " " + d.dd);
  if (scene.performers && scene.performers[0])
    list.push(studio + " " + scene.performers[0].name);
  list.push(studio + " " + scene.title);
  return list;
}

function findSceneTorrents(scene) {
  return collectTorrents(sceneSearches(scene), function(name) {
    return sceneMatch(name, scene);
  });
}

/** What Find releases searches for a title: a scene's studio and date (as its releases are named), else its title */
function releaseQuery(providerId, t) {
  var d = dateParts(t.releaseDate);
  return providerId === "scenes" && t.studio && d
    ? t.studio.name + " " + d.yy + " " + d.mm + " " + d.dd
    : t.title;
}

function notesOf(t) {
  var p = present(t.name),
    notes = [];
  if (p.studio) notes.push(p.studio);
  if (p.year) notes.push(String(p.year));
  if (t.scenes) notes.push("Split scenes");
  if (t.audio === "unsupported") notes.push("Probably no sound");
  else if (!t.playable) notes.push("May not play");
  notes.push(clip(t.provider, 80));
  return notes.slice(0, 6);
}

// ── catalogs ────────────────────────────────────────────────────────────────

// TMDB has no filter or genres for these titles: they're reached through
// their studios (production companies, checked Oct 2026: each lists ≥ 40
// titles with posters), and searches keep only flagged results
var TMDB_STUDIOS = [
  ["8552", "Brazzers"],
  ["97168", "Vixen"],
  ["63844", "Blacked"],
  ["72478", "Tushy"],
  ["6463", "Evil Angel"],
  ["6112", "Digital Playground"],
  ["6258", "Dorcel"],
  ["6316", "Naughty America"],
  ["15887", "Reality Kings"],
  ["33400", "Jules Jordan Video"],
  ["6886", "Elegant Angel"],
  ["6122", "New Sensations"],
  ["5788", "Private"],
  ["5979", "Vivid Entertainment"],
  ["120963", "Deeper"],
  ["103790", "Blacked Raw"],
  ["117838", "Tushy Raw"],
  ["97187", "Pure Taboo"],
  ["114045", "Adult Time"],
  ["6978", "Girlfriends Films"],
  ["10294", "Sweetheart Video"],
  ["6115", "Hustler Video"],
  ["56675", "Bang Bros"],
  ["107132", "Mofos"],
  ["46264", "Team Skeet"],
  ["8248", "Devil's Film"],
  ["8027", "Lethal Hardcore"],
  ["6228", "Zero Tolerance"],
  ["6121", "Digital Sin"],
  ["65222", "Mile High Xtreme"],
  ["32777", "Erotica X"],
  ["99678", "Dark X"],
  ["111525", "MissaX"],
  ["122166", "Bellesa Films"],
  ["168340", "Slayed"],
  ["8679", "Kink"],
].map(function(s) {
  return { id: s[0], name: s[1] };
});

// The second provider's site ids (checked Oct 2026: exact name, each with ≥ 50 movies)
var TPDB_SITES = [
  ["92", "Brazzers"],
  ["3372", "Vixen"],
  ["200", "Blacked"],
  ["3417", "Tushy"],
  ["4611", "Evil Angel"],
  ["347", "Digital Playground"],
  ["6551", "Marc Dorcel"],
  ["130", "Naughty America"],
  ["20", "Reality Kings"],
  ["1052", "Elegant Angel"],
  ["202", "Blacked Raw"],
  ["247", "Tushy Raw"],
  ["3373", "Deeper"],
  ["3374", "New Sensations"],
  ["765", "Private"],
  ["4633", "Pure Taboo"],
  ["4432", "Adult Time"],
  ["4628", "Wicked"],
  ["36685", "Hustler"],
  ["65", "Mofos"],
  ["278", "Team Skeet"],
  ["4404", "Girlfriends Films"],
  ["263", "Sweetheart Video"],
  ["1287", "Zero Tolerance"],
  ["4635", "Devil's Film"],
  ["3418", "Digital Sin"],
  ["4376", "Erotica X"],
  ["4388", "Dark X"],
  ["6103", "Slayed"],
  ["2274", "MissaX"],
  ["353", "Kink"],
  ["1001", "Penthouse"],
  ["6497", "Vivid"],
  ["1006", "Lethal Hardcore"],
  ["1056", "Adam & Eve"],
].map(function(s) {
  return { id: s[0], name: s[1] };
});

var HOME_STUDIOS = 10; // the first ones get a row on the home page

// A provider answers pages { items: [Item], page, totalPages };
// Item = { id, title, year, releaseDate, overview, poster, backdrop, rating, studio }
var PROVIDERS = {
  tmdb: {
    name: "TMDB",
    secret: "tmdbApiKey",
    sorts: ["popular", "newest", "rated"],
    periods: [
      ["", "Any time"],
      ["year", "This year"],
      ["5y", "Last 5 years"],
      ["classic", "Before 2015"],
    ],
    studios: TMDB_STUDIOS,
    get: function(key, path, params) {
      return getJson(
        TMDB +
        path +
        "?" +
        qs(Object.assign({ api_key: key, language: "en-US" }, params)),
      );
    },
    item: function(r, studio) {
      var date = r.release_date || "";
      return {
        id: String(r.id),
        title: r.title || r.original_title || "Untitled",
        year: date ? Number(date.slice(0, 4)) : null,
        releaseDate: date || null,
        overview: r.overview || "",
        poster: r.poster_path ? TMDB_IMG + "w342" + r.poster_path : null,
        backdrop: r.backdrop_path ? TMDB_IMG + "w1280" + r.backdrop_path : null,
        rating: r.vote_count >= 3 && r.vote_average ? r.vote_average : null,
        studio: studio || null,
      };
    },
    page: function(data, studio, withPoster) {
      var self = this;
      return {
        items: (data.results || [])
          .filter(function(r) {
            return r.adult && (!withPoster || r.poster_path);
          })
          .map(function(r) {
            return self.item(r, studio);
          }),
        page: data.page || 1,
        totalPages: Math.min(data.total_pages || 1, MAX_PAGE),
      };
    },
    period: function(period) {
      var year = new Date().getFullYear();
      return period === "year"
        ? { "primary_release_date.gte": year + "-01-01" }
        : period === "5y"
          ? { "primary_release_date.gte": year - 5 + "-01-01" }
          : period === "classic"
            ? { "primary_release_date.lte": "2014-12-31" }
            : {};
    },
    home: function() {
      return [
        ["popular", "Popular now"],
        ["newest", "New releases"],
        ["rated", "Top rated"],
      ]
        .map(function(r) {
          return { row: r[0], title: r[1] };
        })
        .concat(
          TMDB_STUDIOS.slice(0, HOME_STUDIOS).map(function(s) {
            return { row: "studio:" + s.id, title: s.name };
          }),
        );
    },
    discover: function(key, o) {
      var self = this,
        studio = o.studio
          ? TMDB_STUDIOS.filter(function(s) {
            return s.id === String(o.studio);
          })[0] || { id: String(o.studio), name: "" }
          : null;
      var params = Object.assign(
        {
          include_adult: true,
          with_companies: studio
            ? studio.id
            : TMDB_STUDIOS.map(function(s) {
              return s.id;
            }).join("|"),
          page: Math.min(Math.max(1, o.page || 1), MAX_PAGE),
        },
        this.period(o.period),
      );
      if (!params["primary_release_date.lte"]) {
        params["primary_release_date.lte"] = today();
      }
      if (o.sort === "newest") {
        params.sort_by = "primary_release_date.desc";
      } else if (o.sort === "rated") {
        params.sort_by = "vote_average.desc";
        params["vote_count.gte"] = 5;
      } else {
        params.sort_by = "popularity.desc";
      }
      return this.get(key, "/discover/movie", params).then(function(data) {
        return self.page(data, studio, true);
      });
    },
    row: function(key, row, page) {
      var studio = /^studio:(\d+)$/.exec(row);
      return this.discover(
        key,
        studio ? { studio: studio[1], page: page } : { sort: row, page: page },
      );
    },
    // TMDB ranks every regular match before the flagged ones: they start after
    // the regular count. Our page n reads the TMDB page where they start + 2(n − 1), and the next
    search: function(key, o) {
      var self = this,
        q = String(o.q || "").trim(),
        page = Math.max(1, o.page || 1);
      if (!q) {
        return Promise.resolve({ items: [], page: 1, totalPages: 1 });
      }
      return Promise.all([
        this.get(key, "/search/movie", {
          query: q,
          include_adult: false,
          page: 1,
        }),
        this.get(key, "/search/movie", {
          query: q,
          include_adult: true,
          page: 1,
        }),
      ]).then(function(counts) {
        var first = Math.floor((counts[0].total_results || 0) / PAGE_SIZE) + 1,
          last = Math.min(
            Math.ceil((counts[1].total_results || 0) / PAGE_SIZE),
            MAX_PAGE,
          ),
          from = first + (page - 1) * 2;
        if (from > last) {
          return { items: [], page: page, totalPages: page };
        }
        return Promise.all(
          [from, from + 1]
            .filter(function(p) {
              return p <= last;
            })
            .map(function(p) {
              return p === 1
                ? counts[1]
                : self.get(key, "/search/movie", {
                  query: q,
                  include_adult: true,
                  page: p,
                });
            }),
        ).then(function(pages) {
          var seen = {},
            period = self.period(o.period),
            items = [];
          pages.forEach(function(data) {
            self.page(data).items.forEach(function(it) {
              if (seen[it.id]) return;
              seen[it.id] = true;
              if (
                period["primary_release_date.gte"] &&
                (!it.releaseDate ||
                  it.releaseDate < period["primary_release_date.gte"])
              )
                return;
              if (
                period["primary_release_date.lte"] &&
                (!it.releaseDate ||
                  it.releaseDate > period["primary_release_date.lte"])
              )
                return;
              items.push(it);
            });
          });
          return {
            items: items,
            page: page,
            totalPages: Math.max(page, Math.ceil((last - first + 1) / 2)),
          };
        });
      });
    },
    title: function(key, id) {
      var self = this;
      return this.get(key, "/movie/" + encodeURIComponent(id), {
        append_to_response: "credits",
      }).then(function(m) {
        if (!m.adult) {
          throw new Error("not an 18+ title");
        }
        var companies = (m.production_companies || []).map(function(c) {
          return { id: String(c.id), name: c.name };
        }),
          known = companies.filter(function(c) {
            return TMDB_STUDIOS.some(function(s) {
              return s.id === c.id;
            });
          })[0],
          credits = m.credits || {},
          director = (credits.crew || []).filter(function(c) {
            return c.job === "Director";
          })[0];
        return Object.assign(self.item(m, known || companies[0] || null), {
          runtime: m.runtime || null,
          performers: (credits.cast || []).slice(0, 20).map(function(c) {
            return {
              name: c.name,
              photo: c.profile_path ? TMDB_IMG + "w185" + c.profile_path : null,
            };
          }),
          director: director ? director.name : null,
          browsableStudio: known ? known.id : null,
        });
      });
    },
  },

  // Second provider: covers, performers, studios ("sites"); only newest-first sorting
  // (checked Oct 2026), future-dated scraped entries dropped, one site per request
  theporndb: {
    name: "ThePornDB",
    secret: "theporndbApiKey",
    sorts: ["newest"],
    periods: [
      ["", "Any time"],
      ["year", "This year"],
      ["last", "Last year"],
    ],
    studios: TPDB_SITES,
    get: function(key, path, params) {
      return getJson(TPDB + path + (params ? "?" + qs(params) : ""), {
        Authorization: "Bearer " + key,
        Accept: "application/json",
      });
    },
    pick: function(obj, paths) {
      for (
