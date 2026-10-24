'use strict';

// The core's collect handlers of the play pipeline (./index.js), written like
// a plugin's (docs/plugins-plan.md: play.collect):
//   library    files of the item in the library (lib/library matched them)
//   downloads  the server's downloads of the title: their `title` (a Download
//              of a title page, a player's keepalive), else their name
//   yts        movie torrents (YTS by IMDb id)
//   episodes   episode torrents (EZTV + TheRARBG, ranked by lib/media/names.js)

var path = require('path'),
  torrents = require('../torrents/client'),
  refs = require('../media/refs'),
  mediaFiles = require('../media/files'),
  names = require('../media/names'),
  parse = require('../library/parse'),
  yts = require('../providers/yts');

var CONTAINERS_NEVER = ['avi', 'wmv', 'ts', 'm2ts'],
  VIDEO_NEVER = ['mpeg4', 'msmpeg4v3', 'msmpeg4v2', 'mpeg2video', 'mpeg1video', 'vc1', 'wmv3'];

// 1920 × 800 is a 1080p film in scope: read the width
function qualityOf(width, fallback) {
  if (!width) {
    return fallback || null;
  }
  return width >= 3200 ? '2160p' : width >= 1700 ? '1080p' : width >= 1100 ? '720p' : '480p';
}

function extension(name) {
  return path.extname(name).slice(1).toLowerCase();
}

// A library file: what ffprobe found, else what its name says
function fileSource(file, play, ffmpeg) {
  var name = path.basename(file.relPath),
    probe = file.probe || null,
    parsed = file.parse || {},
    verdict;
  if (CONTAINERS_NEVER.indexOf(extension(name)) !== -1 || (probe && VIDEO_NEVER.indexOf(probe.video) !== -1)) {
    verdict = { playable: 'no', notes: ['Won\'t play here (' + (probe && probe.video || extension(name)) + ')'] };
  } else if (!probe) {
    verdict = play.playableByName(name, ffmpeg);
  } else if (probe.video === 'hevc') {
    verdict = { playable: 'maybe', notes: ['May not play (HEVC)'] };
  } else if (probe.transcode) {
    verdict = ffmpeg ? { playable: 'audio-converted', notes: ['Sound converted by the server'] } :
      { playable: 'no', notes: ['Probably no sound (Dolby / DTS audio)'] };
  } else {
    verdict = { playable: 'yes', notes: [] };
  }
  var main = probe && probe.audio && probe.audio[0];
  return {
    id: refs.file(file.id),
    type: 'file',
    provider: 'library',
    label: name,
    ref: refs.file(file.id),
    size: file.size,
    quality: qualityOf(probe && probe.width, parsed.resolution),
    codec: probe ? probe.video : parsed.codec || null,
    audio: main ? main.codec : null,
    duration: probe && probe.duration || null,
    playable: verdict.playable,
    notes: verdict.notes,
    badges: ['on-server'].concat(probe && probe.hdr ? ['hdr'] : [])
  };
}

var library = {
  id: 'library',
  order: 10,
  run: function (title, context) {
    var s = context.services,
      identity = title.kind === 'movie' ? { kind: 'movie', tmdbId: title.tmdbId } :
        { kind: 'episode', showTmdbId: title.tmdbId, season: title.season, episode: title.episode };
    return Promise.all([s.library.filesFor(identity), s.library.folders()]).then(function (r) {
      var folders = {};
      r[1].forEach(function (f) { folders[f.id] = f; });
      return r[0].filter(function (file) {
        var folder = folders[file.folderId];
        // a kids profile never gets files of an adults-only folder
        return folder && !(context.kid && folder.audience === 'adults');
      }).map(function (file) {
        return fileSource(file, context.play, context.ffmpeg);
      });
    });
  }
};

// The download's file for this title: the episode's (also inside a pack), else its largest video
function fileFor(files, title) {
  return mediaFiles.choose(files, title.kind === 'episode' ? { season: title.season, episode: title.episode } : {});
}

// The download is this title: by its title, else by its name
function isTitle(download, title) {
  var t = download.title;
  if (t && t.tmdbId) {
    return t.mediaType === (title.kind === 'movie' ? 'movie' : 'tv') && Number(t.tmdbId) === title.tmdbId;
  }
  var parsed = parse(download.name || ''),
    // a season pack ("Show.S02.1080p") reads as a film named "Show S02"
    pack = parsed.kind === 'movie' && /^(.*?)\s+(?:s|season\s*)(\d{1,2})$/i.exec(parsed.title || '');
  if (pack) {
    parsed = Object.assign({}, parsed, { kind: 'episode', title: pack[1], season: +pack[2] });
  }
  if (!parsed.title || names.normalizeTitle(parsed.title) !== names.normalizeTitle(title.title)) {
    return false;
  }
  if (title.kind === 'movie') {
    return parsed.kind === 'movie' && (!parsed.year || !title.year || parsed.year === title.year);
  }
  return parsed.kind === 'episode' && (parsed.season === null || parsed.season === title.season);
}

var downloads = {
  id: 'downloads',
  order: 20,
  run: function (title, context) {
    var found = [];
    torrents.list().forEach(function (d) {
      if (d.state === 'error' || !isTitle(d, title)) {
        return;
      }
      var file = fileFor(torrents.files(d.infoHash) || [], title);
      if (!file) {
        return;
      }
      var done = d.state === 'completed' && file.selected || (file.doneBytes !== null && file.doneBytes >= file.size),
        progress = done ? 1 : file.doneBytes !== null && file.size ? file.doneBytes / file.size : d.progress || 0,
        verdict = context.play.playableByName(file.name + ' ' + d.name, context.ffmpeg);
      found.push({
        id: file.ref,
        type: 'download',
        provider: 'downloads',
        label: file.name,
        ref: file.ref,
        infoHash: d.infoHash,
        path: file.path,
        size: file.size,
        quality: verdict.description.quality,
        codec: verdict.description.codec,
        playable: verdict.playable,
        notes: verdict.notes,
        progress: Math.min(1, progress),
        state: d.state,
        badges: done ? ['on-server'] : ['downloading']
      });
    });
    return found;
  }
};

// A provider's torrent as a Source
function torrentSource(t, provider, context) {
  var verdict = context.play.playableByName(t.name, context.ffmpeg),
    badges = [];
  if (t.pack) {
    badges.push('pack');
  }
  return {
    id: 'torrent:' + t.hash,
    type: 'torrent',
    provider: provider || String(t.provider || '').toLowerCase(),
    label: t.name,
    infoHash: t.hash,
    magnet: t.magnet,
    size: t.size || null,
    quality: verdict.description.quality,
    codec: verdict.description.codec,
    audio: verdict.description.audio,
    seeds: t.seeds,
    peers: t.peers === undefined ? null : t.peers,
    playable: verdict.playable,
    notes: verdict.notes,
    badges: badges
  };
}

var movieTorrents = {
  id: 'yts',
  order: 30,
  kinds: ['movie'],
  network: true,
  run: function (title, context) {
    if (!title.imdbId) {
      return [];
    }
    return yts.releases(title.imdbId).then(function (list) {
      // ranked like episodes (YTS lists 720p first)
      return list.map(function (t) {
        return Object.assign({}, t, names.describe(t.name), { pack: false });
      }).sort(names.compare).map(function (t) { return torrentSource(t, 'yts', context); });
    });
  }
};

var episodeTorrents = {
  id: 'episodes',
  order: 30,
  kinds: ['episode'],
  network: true,
  run: function (title, context) {
    return episodes.findEpisodeTorrents(title.imdbId, title.title, title.season, title.episode).then(function (r) {
      return {
        sources: r.torrents.map(function (t) { return torrentSource(t, null, context); }),
        errors: r.providerErrors ? [r.providerErrors + ' torrent provider(s) unreachable'] : []
      };
    });
  }
};

module.exports = {
  register: function (play) {
    [library, downloads, movieTorrents, episodeTorrents].forEach(play.use);
  },
  qualityOf: qualityOf,
  // tests
  fileFor: fileFor,
  isTitle: isTitle
};
