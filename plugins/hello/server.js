// The example plugin (docs/plugins/README.md): every screen template, the
// slots, effects and settings, with made-up titles and no network. Runs in
// the server's sandbox (docs/plugins/server.md); the TV draws its screens
// with core templates (docs/plugins/templates.md).
//
// Data handlers and what the core sends them:
//   home      catalog   { params, query, filters: { decade: [...] } }
//   page      row page  { page, decade? }       (a row's `page` call)
//   title     title     { params: { id } }
//   releases  releases  { params: { id }, query, filters, page }
//   menu      list      { params }
//   wave / more                                 actions' and cards' calls: effects only
//   movieAction, moviesRow, titleMeta, searchFilter   slots: { slot, context }
//   testConnection                              the dashboard's action setting
//   addToList, whoami                           calls: a write to the watch list, the linked account
//   linkStart, linkSubmit                       the "Hello account" link (custom: a form on the dashboard)
//
// And (plugins plan P3b): watchlist.added → a notification to that profile,
// a job every hour counting its runs.

var TITLES = [];
var WORDS = ['Quiet', 'Paper', 'Northern', 'Glass', 'Last', 'Hidden', 'Silver', 'Long', 'Wild', 'Little'];
var NOUNS = ['Harbour', 'Lanterns', 'Orchard', 'Signal', 'Summer', 'Garden', 'Machine', 'River', 'Station', 'Comet'];
for (var i = 1; i <= 60; i++) {
  TITLES.push({
    id: i,
    title: WORDS[i % 10] + ' ' + NOUNS[(i * 7) % 10],
    year: 1960 + ((i * 13) % 64),
    rating: 4 + ((i * 37) % 60) / 10,
    poster: 'assets/poster-' + (1 + (i % 6)) + '.svg'
  });
}

function byId(id) {
  return TITLES.filter(function (t) { return t.id === Number(id); })[0] || TITLES[0];
}

function overview(t) {
  return t.title + ' is a made-up title of the example plugin, from ' + t.year + '. Its screens are drawn by the core\'s templates from what this plugin answers.';
}

function hashOf(id, n) {
  var h = '';
  for (var k = 0; h.length < 40; k++) {
    h += ((id * 2654435761 + n * 40503 + k * 97) >>> 0).toString(16);
  }
  return h.slice(0, 40);
}

function settingsOf(ctx) {
  var keys = ['greeting', 'shout', 'rowSize', 'minRating'];
  var profileKeys = ctx && ctx.profile ? ['layout', 'showReleases', 'nickname'] : [];
  return Promise.all(keys.concat(profileKeys).map(function (k) { return playpex.settings.get(k, ctx); })).then(function (v) {
    var out = {};
    keys.concat(profileKeys).forEach(function (k, n) { out[k] = v[n]; });
    out.greeting = out.greeting || 'Hello';
    if (out.shout) out.greeting = out.greeting.toUpperCase() + '!';
    return out;
  });
}

function shown(s, decade) {
  return TITLES.filter(function (t) {
    return t.rating >= (s.minRating || 0) && (!decade || Math.floor(t.year / 10) * 10 === Number(decade));
  });
}

function card(t, s) {
  var variant = s.layout === 'still' ? 'still' : 'poster';
  return {
    key: 'hello:' + t.id,
    title: t.title,
    variant: variant,
    image: t.poster,
    subtitle: String(t.year),
    rating: { source: 'provider', value: t.rating },
    intent: { screen: 'plugin.hello.title', params: { id: t.id } },
    info: {
      title: t.title,
      meta: [{ kind: 'text', text: String(t.year) }, { kind: 'chip', text: 'Example' }, { kind: 'score', source: 'provider', value: t.rating, label: 'Hello' }],
      overview: overview(t)
    }
  };
}

playpex.data('home', function (args, ctx) {
  return settingsOf(ctx).then(function (s) {
    var decades = (args.filters && args.filters.decade) || [];
    var decade = decades[0] || null;
    var query = String(args.query || '').toLowerCase();
    var who = s.nickname ? ', ' + s.nickname : '';
    if (query) {
      var found = shown(s, decade).filter(function (t) { return t.title.toLowerCase().indexOf(query) !== -1; });
      return { data: {
        title: s.greeting + who,
        search: true,
        filters: filters(decade),
        rows: found.length ? [{ key: 'hello:results', title: 'Results for “' + args.query + '”', variant: s.layout === 'still' ? 'still' : 'poster', items: found.slice(0, 100).map(function (t) { return card(t, s); }) }] : [],
        empty: 'No made-up title matches “' + args.query + '”.'
      } };
    }
    return { data: {
      title: s.greeting + who,
      search: true,
      filters: filters(decade),
      rows: [
        { key: 'hello:all', title: decade ? 'Made-up titles from the ' + decade + 's' : 'Made-up titles', variant: s.layout === 'still' ? 'still' : 'poster',
          page: { data: 'page', args: decade ? { decade: String(decade) } : {} } },
        { key: 'hello:best', title: 'Best rated', items: shown(s, decade).slice().sort(function (a, b) { return b.rating - a.rating; }).slice(0, 10).map(function (t) { return card(t, s); }) }
      ],
      empty: 'No made-up title in the ' + decade + 's above that rating.'
    } };
  });
});

function filters(decade) {
  var options = [1960, 1970, 1980, 1990, 2000, 2010, 2020].map(function (d) {
    return { value: String(d), label: d + 's', on: String(d) === String(decade) };
  });
  return [{ key: 'decade', label: 'Decade', options: options }];
}

playpex.data('page', function (args, ctx) {
  return settingsOf(ctx).then(function (s) {
    var list = shown(s, args.decade), size = s.rowSize || 12, page = args.page || 1;
    var items = list.slice((page - 1) * size, page * size);
    return { data: { items: items.map(function (t) { return card(t, s); }), last: page * size >= list.length } };
  });
});

playpex.data('title', function (args, ctx) {
  var t = byId(args.params && args.params.id);
  return settingsOf(ctx).then(function (s) {
    var actions = [
      { key: 'hello:wave', label: 'Say hello', icon: 'film', call: { data: 'wave', args: { id: t.id } } }
    ];
    if (s.showReleases !== false) {
      actions.push({ key: 'hello:releases', label: 'Releases', icon: 'list', intent: { screen: 'plugin.hello.releases', params: { id: t.id } } });
    }
    actions.push({ key: 'hello:menu', label: 'Menu', icon: 'opts', intent: { screen: 'plugin.hello.menu' } });
    var similar = TITLES.filter(function (x) { return x.id !== t.id && Math.abs(x.year - t.year) < 8; }).slice(0, 12);
    return { data: {
      info: {
        title: t.title,
        meta: [{ kind: 'text', text: String(t.year) }, { kind: 'chip', text: 'Example plugin' }, { kind: 'score', source: 'provider', value: t.rating, label: 'Hello' }],
        genres: ['Made up', 'Example'],
        overview: overview(t),
        credits: [{ label: 'Made by', names: ['The example plugin'] }]
      },
      actions: actions,
      rows: [{ key: 'hello:similar', title: 'From around ' + t.year, items: similar.map(function (x) { return card(x, s); }) }]
    } };
  });
});

playpex.data('wave', function (args, ctx) {
  return settingsOf(ctx).then(function (s) {
    var t = byId(args.id);
    return { effects: [{ type: 'confirm', question: 'Say ' + s.greeting + ' to ' + t.title + '?', yes: 'Say it', no: 'Not now',
      then: { type: 'toast', text: playpexSaid(s.greeting) + ' (' + t.title + ')', tone: 'success' } }] };
  });
});

function playpexSaid(greeting) {
  return greeting + ' from the example plugin';
}

var QUALITIES = ['2160p', '1080p', '720p', '480p'];

playpex.data('releases', function (args) {
  var t = byId(args.params && args.params.id), page = args.page || 1;
  var query = String(args.query || '').toLowerCase();
  var quality = ((args.filters && args.filters.quality) || [])[0] || null;
  var all = [];
  for (var n = 0; n < 45; n++) {
    var q = QUALITIES[n % 4];
    all.push({
      title: t.title.replace(/ /g, '.') + '.' + t.year + '.' + q + '.WEB.x264-HELLO' + (n + 1),
      infoHash: hashOf(t.id, n),
      size: Math.round((n % 4 === 0 ? 8 : n % 4 === 1 ? 2.2 : n % 4 === 2 ? 1.1 : 0.7) * 1073741824),
      seeds: Math.max(0, 900 - n * 19),
      peers: 40 + n,
      quality: q,
      uploadedAt: new Date(Date.UTC(2026, 0, 1 + n)).toISOString()
    });
  }
  var list = all.filter(function (r) {
    return (!quality || r.quality === quality) && (!query || r.title.toLowerCase().indexOf(query) !== -1);
  });
  return { data: {
    title: t.title,
    releases: list.slice((page - 1) * 20, page * 20),
    last: page * 20 >= list.length,
    filters: [{ key: 'quality', label: 'Quality', options: QUALITIES.map(function (q) { return { value: q, label: q, on: q === quality }; }) }],
    empty: 'No made-up release matches.'
  } };
});

playpex.data('menu', function () {
  return { data: {
    title: 'Hello menu',
    items: [
      { key: 'hello:first', label: TITLES[0].title, meta: String(TITLES[0].year), icon: 'film', intent: { screen: 'plugin.hello.title', params: { id: 1 } } },
      { key: 'hello:home', label: 'The section', meta: 'Back to the catalog', icon: 'rows', intent: { screen: 'plugin.hello.home' } },
      { key: 'hello:toast', label: 'Show a message', meta: 'A call answering a toast', icon: 'opts', call: { data: 'more', args: { what: 'toast' } } },
      { key: 'hello:whoami', label: 'Who am I?', meta: 'The linked Hello account', icon: 'opts', call: { data: 'whoami' } },
      { key: 'hello:movie', label: 'Open a core movie', meta: 'The Matrix (TMDB 603)', icon: 'film', intent: { screen: 'core.movie', params: { id: 603 } } }
    ]
  } };
});

playpex.data('more', function (args) {
  if (args.what === 'refresh') {
    return { effects: [{ type: 'toast', text: 'Refreshed', tone: 'info' }, { type: 'refresh', target: 'screen' }] };
  }
  return { effects: [{ type: 'toast', text: 'A message from the example plugin', tone: 'info' }] };
});

// ── slots ──────────────────────────────────────────────────────────────────

playpex.data('movieAction', function (args) {
  var movie = args.context && args.context.movie;
  if (!movie || !movie.tmdbId) return { data: [] };
  return { data: [
    { key: 'hello:party', label: 'Hello', icon: 'film', intent: { screen: 'plugin.hello.title', params: { id: movie.tmdbId % 60 || 1 } } },
    { key: 'hello:list', label: 'Hello: my list', icon: 'plus', call: { data: 'addToList', args: { tmdbId: movie.tmdbId, title: movie.title } } }
  ] };
});

// A write through the core (write: watchlist): only for profiles the admin
// allowed (dashboard: Plugins › Hello › Settings › Profiles)
playpex.data('addToList', async function (args, ctx) {
  if (!ctx.profile) return { effects: [{ type: 'toast', text: 'Choose a profile first', tone: 'error' }] };
  try {
    await playpex.watchlist.add(ctx.profile.id, { kind: 'movie', tmdbId: args.tmdbId, title: args.title });
    return { effects: [{ type: 'toast', text: 'Hello added ' + (args.title || 'it') + ' to your list', tone: 'success' }] };
  } catch (err) {
    var text = err.code === 'PERMISSION_DENIED' ? 'Ask the server\'s admin to let Hello change your watch list' : 'Hello couldn\'t add it';
    return { effects: [{ type: 'toast', text: text, tone: 'error' }] };
  }
});

playpex.data('moviesRow', function (args, ctx) {
  return settingsOf(ctx).then(function (s) {
    return { data: [{ key: 'hello:picks', title: 'Hello picks (example plugin)', page: { data: 'page', args: {} } }] };
  });
});

playpex.data('titleMeta', function (args) {
  var c = args.context || {};
  return { data: c.kind === 'movie' ? [{ kind: 'chip', text: 'Hello', icon: 'assets/hello.svg' }] : [] };
});

playpex.data('searchFilter', function (args, ctx) {
  var query = String((args.context && args.context.query) || '').toLowerCase();
  return settingsOf(ctx).then(function (s) {
    var found = TITLES.filter(function (t) { return !query || t.title.toLowerCase().indexOf(query) !== -1; }).slice(0, 30);
    return { data: {
      chip: { key: 'hello:search', label: 'Hello' },
      rows: found.length ? [{ key: 'hello:found', title: 'Made-up titles', items: found.map(function (t) { return card(t, s); }) }] : []
    } };
  });
});

// ── the dashboard's action ───────────────────────────────────────────────────

playpex.data('testConnection', function (args, ctx) {
  return Promise.all([settingsOf(ctx), playpex.secrets.get('apiToken')]).then(function (r) {
    return playpex.i18n.t('said', { greeting: r[0].greeting }, ctx).then(function (said) {
      return { effects: [{ type: 'toast', tone: 'success', text: said + (r[1] ? ' (a token is set)' : ' (no token yet)') }] };
    });
  });
});

// ── events, a job, a linked account (plugins plan P3b) ───────────────────────

// Something added to a watch list (by the profile, or another plugin): tell that profile
playpex.events.on('watchlist.added', function (e) {
  if (!e.context.profile) return;
  var title = e.data.title.title || 'a title';
  return playpex.notify.send([e.context.profile.id], { text: 'Hello saw “' + title + '” on your list', tone: 'info', key: 'watchlist' });
});

playpex.schedule.every('tidy', '1h', async function () {
  var runs = (await playpex.store.get('tidyRuns')) || 0;
  await playpex.store.set('tidyRuns', runs + 1);
});

// The "Hello account": a form on the dashboard (a custom link; real services
// use deviceCode, which the server runs itself)
playpex.data('linkStart', function () {
  return { data: { form: [{ key: 'name', label: 'Your name', help: 'Anything: this account is made up.' }], submit: 'linkSubmit',
    help: 'The example plugin links a made-up account per profile.' } };
});

playpex.data('linkSubmit', async function (args, ctx) {
  var name = String((args.values && args.values.name) || '').trim();
  if (!name) return { data: { state: 'pending', message: 'Type a name' } };
  await playpex.store.set('account:' + ctx.profile.id, name.slice(0, 40));
  return { data: { state: 'done' } };
});

playpex.data('whoami', async function (args, ctx) {
  if (!ctx.profile) return { effects: [{ type: 'toast', text: 'No profile', tone: 'error' }] };
  var status = await playpex.link.status('demo', ctx.profile.id);
  var name = status.linked ? await playpex.store.get('account:' + ctx.profile.id) : null;
  return { effects: [{ type: 'toast', text: name ? 'Linked as ' + name : 'No Hello account linked for this profile yet', tone: name ? 'success' : 'info' }] };
});
