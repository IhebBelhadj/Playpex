// Live TV (M3U): the channels of the admin's M3U playlist, their programmes
// from an XMLTV guide, played by the server (HLS, or MPEG-TS remuxed).
// The host parses both files (playpex.iptv.*): they can be big.

async function settings() {
  return {
    playlist: await playpex.settings.get('playlist'),
    guide: await playpex.settings.get('guide'),
    playlistGuide: await playpex.settings.get('playlistGuide'),
    groups: String(await playpex.settings.get('groups') || '').split(',').map(g => g.trim().toLowerCase()).filter(Boolean)
  };
}

// The playlist's entries the admin wants (its groups)
async function entries() {
  const s = await settings();
  if (!s.playlist) return { s, list: [], epg: [] };
  const answer = await playpex.iptv.m3u(s.playlist);
  const list = s.groups.length ? answer.channels.filter(e => e.group && s.groups.includes(e.group.toLowerCase())) : answer.channels;
  return { s, list, epg: answer.epg };
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

playpex.hooks.on('live.guide', async (input) => {
  const { s, list, epg } = await entries();
  const url = s.guide || (s.playlistGuide ? epg[0] : null);
  if (!url) return { programmes: [] };
  const byId = new Map(list.map(e => [e.id, e]));
  const channels = input.channels.map(id => byId.get(id)).filter(Boolean)
    .map(e => ({ id: e.id, tvgId: e.tvgId, name: e.tvgName || e.name }));
  if (!channels.length) return { programmes: [] };
  const answer = await playpex.iptv.xmltv(url, { channels, from: input.from, to: input.to });
  return { programmes: answer.programmes };
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
      empty: s.playlist ? 'The playlist has no channels (or none in the groups chosen).' : 'No playlist yet: the server\'s admin adds one on the dashboard (Plugins › Live TV (M3U) › Settings).'
    }
  };
});
