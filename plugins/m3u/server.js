// Live TV (M3U): the channels of the admin's M3U playlists (up to PLAYLISTS,
// shown together), their programmes from XMLTV guides, played by the server
// (HLS, or MPEG-TS remuxed). The host parses both files (playpex.iptv.*):
// they can be big.
//
// Channel ids: the first playlist's as the host makes them (so they stay what
// they were before there were several), the others' prefixed `<n>:`.

const PLAYLISTS = 5;

function suffix(n) {
  return n === 1 ? '' : String(n);
}

async function settings() {
  const playlists = [];
  for (let n = 1; n <= PLAYLISTS; n++) {
    const url = await playpex.settings.get('playlist' + suffix(n));
    if (url) playlists.push({ n, url, guide: await playpex.settings.get('guide' + suffix(n)) });
  }
  return {
    playlists,
    playlistGuide: await playpex.settings.get('playlistGuide'),
    groups: String(await playpex.settings.get('groups') || '').split(',').map(g => g.trim().toLowerCase()).filter(Boolean)
  };
}

function idOf(n, id) {
  return n === 1 ? id : (n + ':' + id).slice(0, 100);
}

// Every playlist's entries the admin wants (its groups), each with its
// playlist; a playlist that fails is left out (logged) so the others still show
async function entries() {
  const s = await settings();
  const answers = await Promise.all(s.playlists.map(p => playpex.iptv.m3u(p.url).then(answer => ({ p, answer }), err => {
    playpex.log.warn('playlist ' + p.n + ' not read: ' + (err && err.message));
    return null;
  })));
  const list = [], seen = new Set(), numbers = new Set(), guides = [];
  answers.filter(Boolean).forEach(({ p, answer }) => {
    const guide = p.guide || (s.playlistGuide ? (answer.epg || [])[0] : null);
    if (guide) guides.push({ n: p.n, url: guide });
    answer.channels.forEach(e => {
      if (s.groups.length && !(e.group && s.groups.includes(e.group.toLowerCase()))) return;
      const id = idOf(p.n, e.id);
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
