// Live TV (M3U): the channels of the admin's M3U playlists (a list setting:
// as many as they have, up to 20, shown together in its order), their
// programmes from XMLTV guides, played by the server (HLS, or MPEG-TS
// remuxed). The host parses both files (playpex.iptv.*): they can be big.
//
// Channel ids: the first playlist's as the host makes them (so they stay what
// they were with one playlist), the others' prefixed `<entry id>:` (the
// entry's id is kept by the server when playlists are renamed or moved).
//
// 2.0 (plugin API 1.5): the five fixed pairs of 1.x (`playlist` / `guide`,
// `playlist2` / `guide2` … `playlist5` / `guide5`) and the comma-separated
// `groups` became the lists `playlists` and `groups`; `migrate` carries an
// admin's 1.x values over on the update.

async function settings() {
  const list = await playpex.settings.get('playlists');
  const groups = await playpex.settings.get('groups');
  const playlists = (Array.isArray(list) ? list : [])
    .filter(p => p && p.url && p.on !== false)
    .map((p, i) => ({ n: i + 1, key: i === 0 ? null : p.id, name: p.name || 'Playlist ' + (i + 1), url: p.url, guide: p.guide || null }));
  return {
    playlists,
    playlistGuide: await playpex.settings.get('playlistGuide'),
    groups: (Array.isArray(groups) ? groups : []).map(g => String(g).trim().toLowerCase()).filter(Boolean)
  };
}

function idOf(p, id) {
  return p.key ? (p.key + ':' + id).slice(0, 100) : id;
}

// Every playlist's entries the admin wants (its groups), each with its
// playlist; a playlist that fails is left out (logged) so the others still show
async function entries() {
  const s = await settings();
  const answers = await Promise.all(s.playlists.map(p => playpex.iptv.m3u(p.url).then(answer => ({ p, answer }), err => {
    playpex.log.warn('playlist ' + p.name + ' not read: ' + (err && err.message));
    return null;
  })));
  const list = [], seen = new Set(), numbers = new Set(), guides = [];
  answers.filter(Boolean).forEach(({ p, answer }) => {
    const guide = p.guide || (s.playlistGuide ? (answer.epg || [])[0] : null);
    if (guide) guides.push({ n: p.n, url: guide });
    answer.channels.forEach(e => {
      if (s.groups.length && !(e.group && s.groups.includes(e.group.toLowerCase()))) return;
      const id = idOf(p, e.id);
      if (seen.has(id)) return;
      seen.add(id);
      // a number an earlier playlist took: the server numbers it after the highest
      const number = e.number && !numbers.has(e.number) ? e.number : null;
      if (number) numbers.add(number);
      list.push(Object.assign({}, e, { id, number, playlist: p.n }));
    });
  });
  return { s, list, guides };
}

function channelOf(e) {
  const c = { id: e.id, name: e.name };
  if (e.number) c.number = e.number;
  if (e.logo) c.logo = e.logo;
  if (e.group) c.group = e.group.slice(0, 60);
  if (e.country) c.country = e.country;
  const lang = /^[a-z]{2,3}$/i.test(e.language || '') ? e.language.toLowerCase() : null;
  if (lang) c.languages = [lang];
  return c;
}

playpex.hooks.on('live.channels', async () => {
  const { list } = await entries();
  return { channels: list.slice(0, 5000).map(channelOf) };
});

// Each playlist's channels asked of its own guide, side by side
playpex.hooks.on('live.guide', async (input) => {
  const { list, guides } = await entries();
  const byId = new Map(list.map(e => [e.id, e]));
  const wanted = input.channels.map(id => byId.get(id)).filter(Boolean);
  const answers = await Promise.all(guides.map(g => {
    const channels = wanted.filter(e => e.playlist === g.n).map(e => ({ id: e.id, tvgId: e.tvgId, name: e.tvgName || e.name }));
    if (!channels.length) return [];
    return playpex.iptv.xmltv(g.url, { channels, from: input.from, to: input.to }).then(a => a.programmes, err => {
      playpex.log.warn('guide of playlist ' + g.n + ' not read: ' + (err && err.message));
      return [];
    });
  }));
  return { programmes: [].concat(...answers) };
});

playpex.hooks.on('live.stream', async (input) => {
  const { list } = await entries();
  const e = list.find(x => x.id === input.channel.id);
  if (!e) return { source: null };
  const headers = {};
  if (e.userAgent) headers['User-Agent'] = e.userAgent.slice(0, 500);
  if (e.referrer) headers['Referer'] = e.referrer.slice(0, 2000);
  const playlist = /\.m3u8?(\?|$)/i.test(e.url);
  const source = { kind: 'live', url: e.url, label: e.name.slice(0, 200), format: playlist ? 'hls' : 'ts' };
  if (Object.keys(headers).length) source.headers = headers;
  return { source };
});

// The guide screen's name and what it says without channels
playpex.data('guide', async () => {
  const s = await settings();
  return {
    data: {
      title: 'Live TV',
      empty: s.playlists.length ? 'The playlists have no channels (or none in the groups chosen).' : 'No playlist yet: the server\'s admin adds one on the dashboard (Plugins › Live TV (M3U) › Settings).'
    }
  };
});

// 1.x → 2.0: the five fixed pairs into the list, in their order (named after
// their host), the comma-separated groups into the list of groups
playpex.data('migrate', async (args) => {
  const old = (args && args.server) || {};
  const server = {};
  if (!Array.isArray(old.playlists)) {
    const playlists = [];
    for (let n = 1; n <= 5; n++) {
      const suffix = n === 1 ? '' : String(n);
      const url = old['playlist' + suffix];
      if (typeof url !== 'string' || !url) continue;
      // its host (the sandbox has no URL)
      const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@\/?#]*@)?(\[[^\]]+\]|[^:\/?#]+)/i.exec(url);
      const name = host ? host[1].toLowerCase().slice(0, 60) : 'Playlist ' + n;
      const guide = old['guide' + suffix];
      playlists.push({ name, url, guide: typeof guide === 'string' ? guide : '', on: true });
    }
    if (playlists.length) server.playlists = playlists;
  }
  if (typeof old.groups === 'string') {
    const seen = new Set();
    server.groups = old.groups.split(',').map(g => g.trim().slice(0, 60)).filter(g => {
      const k = g.toLowerCase();
      if (!g || seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 200);
  }
  return { data: { server } };
});
