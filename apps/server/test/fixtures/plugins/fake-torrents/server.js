// Fake torrents (test plugin, docs/providers-plan.md step 4): made-up
// releases of any movie or episode, with no site behind them, for the play
// pipeline's and the release lists' tests (test/plugins.sources.test.js).
// Info hashes come from the title, so the same title always gets the same.
//
//   movie    1080p x264 AAC (healthy) · 2160p HEVC Atmos · 720p x264 AAC (2 seeds)
//   episode  the episode 1080p x264 AAC · its season's pack 1080p x264 AAC · another
//            episode (left out by the core's matcher) · 720p XviD

function hex8(text) {
  // FNV-1a, 32 bits
  var h = 0x811c9dc5;
  for (var i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

function hashOf(text) {
  return (hex8(text) + hex8(text + '1') + hex8(text + '2') + hex8(text + '3') + hex8(text + '4')).slice(0, 40);
}

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

function dotted(text) {
  return String(text).replace(/[^\w]+/g, '.').replace(/^\.|\.$/g, '');
}

function releasesOf(t) {
  if (t.kind === 'movie') {
    var base = dotted(t.title) + (t.year ? '.' + t.year : '');
    return [
      { name: base + '.2160p.WEB-DL.DDP5.1.Atmos.HEVC-FAKE', seeds: 900, size: 20e9 },
      { name: base + '.1080p.WEB-DL.x264.AAC-FAKE', seeds: 120, size: 3e9 },
      { name: base + '.720p.WEB.x264.AAC-FAKE', seeds: 2, size: 1e9 }
    ];
  }
  if (t.kind === 'episode') {
    var show = dotted(t.title), s = 'S' + pad(t.season);
    return [
      { name: show + '.' + s + '.1080p.WEB.x264.AAC-FAKE', seeds: 300, size: 30e9, pack: true },
      { name: show + '.' + s + 'E' + pad(t.episode) + '.1080p.WEB.x264.AAC-FAKE', seeds: 40, size: 2e9 },
      { name: show + '.' + s + 'E' + pad(t.episode + 1) + '.1080p.WEB.x264.AAC-FAKE', seeds: 500, size: 2e9 },
      { name: show + '.' + s + 'E' + pad(t.episode) + '.720p.XviD-FAKE', seeds: 80, size: 7e8 }
    ];
  }
  return [];
}

playpex.hooks.on('play.collect', function (input) {
  var t = input.title, list = releasesOf(t);
  if (!list.length) {
    return [];
  }
  return playpex.names.matches(list.map(function (r) { return r.name; }), t).then(function (kinds) {
    return list.filter(function (r, i) { return kinds[i]; }).map(function (r) {
      return { kind: 'magnet', infoHash: hashOf(r.name), label: r.name, size: r.size, seeds: r.seeds };
    });
  });
});

playpex.hooks.on('releases.providers', function (input) {
  if (input.kind !== 'movie' && input.kind !== 'show') {
    return { releases: [], last: true };
  }
  var title = input.query || (input.kind === 'movie' ? 'Fake Film' : 'Fake Show');
  var list = input.kind === 'movie' ? releasesOf({ kind: 'movie', title: title, year: 2020 }) :
    releasesOf({ kind: 'episode', title: title, season: 1, episode: input.page });
  return {
    releases: list.map(function (r) { return { title: r.name, infoHash: hashOf(r.name), seeds: r.seeds, size: r.size }; }),
    last: input.page >= 2
  };
});
