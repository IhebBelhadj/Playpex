'use strict';

// Finds torrents for one TV episode across all providers and ranks them for
// streaming in Electron's Chromium. Video: H.264 plays everywhere; HEVC/x265,
// 10-bit, XviD and 4K often don't, or are too large to stream smoothly.
// Audio: Chromium decodes AAC/Opus/MP3 but not Dolby (AC-3, E-AC-3/DDP,
// TrueHD) or DTS, so those releases play silently.

var eztv = require('./providers/eztv');
var therarbg = require('./providers/therarbg');
var trackers = require('./trackers');
var log = require('./logger').child('provider');

// Seeders needed before a torrent counts as fast enough to stream
var HEALTHY_SEEDS = 10;

var RESOLUTION_RANK = { '1080p': 3, '720p': 2, '480p': 1, 'SD': 1, '2160p': 0 };

// Release names usually state the audio codec; unnamed audio is often AAC
// (re-encodes) but WEB-DLs without a tag tend to carry E-AC-3
var AUDIO_RANK = { supported: 2, unknown: 1, unsupported: 0 };

function describe(name) {
  var resolution = (name.match(/\b(2160p|1080p|720p|480p)\b/i) || [])[1];
  if (!resolution && /\b(4k|uhd)\b/i.test(name)) {
    resolution = '2160p';
  }
  resolution = resolution ? resolution.toLowerCase() : 'SD';

  var hevc = /\b(x265|h\.?265|hevc)\b/i.test(name);
  var tenBit = /\b10.?bit\b/i.test(name);
  var xvid = /\b(xvid|divx)\b/i.test(name);

  var audio = 'unknown';
  if (/\b(ddp?\s?\d|ddp|dd\+|e-?ac-?3|ac-?3|eac3|truehd|atmos|dts(-?hd)?)\b/i.test(name)) {
    audio = 'unsupported';
  } else if (/\b(aac|opus|mp3)/i.test(name)) {
    audio = 'supported';
  }

  return {
    quality: resolution,
    codec: hevc ? 'x265' : xvid ? 'xvid' : 'x264',
    audio: audio,
    playable: !hevc && !tenBit && !xvid && resolution !== '2160p'
  };
}

function normalizeTitle(text) {
  return String(text).toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function titlePrefix(title) {
  return '^' + normalizeTitle(title).replace(/ /g, ' +') + '( (19|20)\\d\\d)?( (us|uk|au|nz|ca))?';
}

// 'episode' when the release is exactly this show's episode ("<title> [year] [US] SxxEyy"),
// 'pack' for a single-season pack of this show ("<title> S02", "<title> Season 2"),
// otherwise null. Rejects other shows that merely contain the words ("Lego Friends",
// "Breaking Brad"), episode ranges ("S01E01-E10", "S01e01 10") and multi-season packs.
function matchKind(name, title, season, episode) {
  var normalized = normalizeTitle(name);
  var prefix = title ? titlePrefix(title) : '^.*?';
  var single = new RegExp(prefix + ' s0*' + season + 'e0*' + episode + '(?!\\d)(?! *e?\\d{1,3}\\b)');
  if (single.test(normalized)) {
    return 'episode';
  }
  var pack = new RegExp(prefix + ' (s0*' + season + '|season 0*' + season + ')(?!\\d)(?! *e\\d)(?! *(s?\\d{1,2}\\b|to\\b))');
  return pack.test(normalized) ? 'pack' : null;
}

function compare(a, b) {
  return (b.playable - a.playable) ||
    (AUDIO_RANK[b.audio] - AUDIO_RANK[a.audio]) ||
    ((b.seeds >= HEALTHY_SEEDS) - (a.seeds >= HEALTHY_SEEDS)) ||
    (a.pack - b.pack) ||
    ((RESOLUTION_RANK[b.quality] || 0) - (RESOLUTION_RANK[a.quality] || 0)) ||
    (b.seeds - a.seeds);
}

// imdbId: "tt0944947" or "0944947"; title: show name (used by text-search providers)
function findEpisodeTorrents(imdbId, title, season, episode) {
  var searches = [];
  if (imdbId) {
    searches.push(eztv.search(String(imdbId).replace(/^tt/, ''), season, episode));
  }
  if (title) {
    searches.push(therarbg.search(title, season, episode));
  }

  return Promise.allSettled(searches).then(function (results) {
    var byHash = {};
    var errors = [];

    results.forEach(function (result) {
      if (result.status === 'rejected') {
        errors.push(result.reason && result.reason.message);
        return;
      }
      result.value.forEach(function (torrent) {
        var kind = matchKind(torrent.name, title, season, episode);
        if (!kind) {
          return;
        }
        var existing = byHash[torrent.hash];
        // Same torrent from several providers: keep the best seed count, but
        // announce to every tracker any of them listed
        var magnets = existing ? [existing.magnet, torrent.magnet] : [torrent.magnet];
        if (!existing || torrent.seeds > existing.seeds) {
          // Packs hold the whole season; the player streams only this episode's file
          byHash[torrent.hash] = Object.assign(torrent, describe(torrent.name), { pack: kind === 'pack' });
        }
        var kept = byHash[torrent.hash];
        kept.magnet = trackers.build(kept.hash, kept.name, magnets);
      });
    });

    if (errors.length) {
      log.warn('episode search errors: ' + errors.join('; '));
    }

    var torrents = Object.keys(byHash).map(function (hash) {
      return byHash[hash];
    });
    torrents.sort(compare);

    return { torrents: torrents, providerErrors: errors.length };
  });
}

module.exports = {
  findEpisodeTorrents: findEpisodeTorrents,
  // shared with adult.js and lib/play
  describe: describe,
  compare: compare,
  normalizeTitle: normalizeTitle,
  AUDIO_RANK: AUDIO_RANK,
  RESOLUTION_RANK: RESOLUTION_RANK,
  HEALTHY_SEEDS: HEALTHY_SEEDS
};
