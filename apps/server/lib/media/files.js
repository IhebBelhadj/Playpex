'use strict';

// The files of a torrent (docs/providers-plan.md §5.1, §6.1): which video
// plays for a title, and what goes with it: the audio and subtitle files of
// that video (the library's sidecar rules, lib/library/walk.js, over a list of
// paths instead of a folder on disk) and the torrent's other videos.
//
//   kindOf(path)                        'video' | 'audio' | 'subtitle' | null
//   choose(files, hint)                 the file to play, or null
//     hint: { season?, episode? (an episode: its file, also inside a pack), fileName?, fileIndex? (a plugin's) }
//   companions(files, video)            { audio: [file], subtitles: [file + language, forced, sdh], videos: [file + kind] }
//
// files: [{ path, size, … }] in the torrent's order (an index is a position in it).

var path = require('path'),
  describeSub = require('../library/walk').describeSub;

var VIDEO = /\.(mkv|mp4|m4v|avi|webm|mov|ts|m2ts|wmv)$/i,
  AUDIO = /\.(mka|ac3|eac3|dts|aac|flac|opus|m4a|mp3|thd)$/i,
  SUBTITLE = /\.(srt|ass|ssa|vtt|sub|idx)$/i,
  // what Chromium plays, best first: the file chosen among equals
  CONTAINERS = ['mp4', 'm4v', 'mkv', 'webm', 'mov'],
  SUBS_DIR = /^(subs|subtitles)$/i,
  AUDIO_DIR = /^(audio|audios|sound|tracks)$/i,
  EXTRAS_DIR = /^(extras?|featurettes?|behind the scenes|deleted scenes|interviews|scenes|shorts|trailers?|samples?|bonus)$/i,
  SAMPLE_BYTES = 100 * 1024 * 1024;

function kindOf(filePath) {
  return VIDEO.test(filePath) ? 'video' : AUDIO.test(filePath) ? 'audio' : SUBTITLE.test(filePath) ? 'subtitle' : null;
}

function parts(filePath) {
  return String(filePath).split(/[\\/]/);
}

function stem(name) {
  return name.replace(/\.[^.]+$/, '');
}

function sample(file) {
  return file.size < SAMPLE_BYTES && /\bsample\b/i.test(path.basename(file.path));
}

// "Extras/…", "Featurettes/…", a sample: never the film
function extra(file) {
  var dirs = parts(file.path).slice(0, -1);
  return dirs.some(function (d) { return EXTRAS_DIR.test(d); }) || sample(file);
}

function episodePattern(season, episode) {
  return new RegExp('(s0*' + season + '[ ._-]*e0*' + episode + '|\\b0*' + season + 'x0*' + episode + ')(?!\\d)', 'i');
}

function containerRank(file) {
  var i = CONTAINERS.indexOf(path.extname(file.path).slice(1).toLowerCase());
  return i === -1 ? CONTAINERS.length : i;
}

// Largest of the containers Chromium plays first, then the others
function best(videos) {
  return videos.slice().sort(function (a, b) {
    return (containerRank(a) < CONTAINERS.length ? 0 : 1) - (containerRank(b) < CONTAINERS.length ? 0 : 1) ||
      b.size - a.size || containerRank(a) - containerRank(b);
  })[0] || null;
}

/**
 * The file to play: the plugin's (by index or name, when it is a video),
 * else an episode's file (named SxxEyy / 1x02, inside packs too; a torrent
 * with one video: that one), else the largest video that isn't an extra.
 */
function choose(files, hint) {
  hint = hint || {};
  var all = files || [],
    videos = all.filter(function (f) { return kindOf(f.path) === 'video'; });
  if (Number.isInteger(hint.fileIndex) && all[hint.fileIndex] && kindOf(all[hint.fileIndex].path) === 'video') {
    return all[hint.fileIndex];
  }
  if (typeof hint.fileName === 'string' && hint.fileName) {
    var wanted = hint.fileName.toLowerCase(),
      named = videos.filter(function (f) {
        return f.path.toLowerCase() === wanted || path.basename(f.path).toLowerCase() === path.basename(wanted);
      });
    if (named.length) {
      return named[0];
    }
  }
  if (Number.isInteger(hint.season) && Number.isInteger(hint.episode)) {
    var pattern = episodePattern(hint.season, hint.episode),
      matching = videos.filter(function (f) { return pattern.test(f.path); });
    if (matching.length) {
      return best(matching);
    }
    var main = videos.filter(function (f) { return !extra(f); });
    return main.length === 1 ? main[0] : null;
  }
  var films = videos.filter(function (f) { return !extra(f); });
  return best(films.length ? films : videos);
}

/**
 * What goes with `video` in the torrent: audio and subtitle files named
 * after it (`Movie.en.srt`, `Movie.Commentary.mka`) or in the same folder
 * when it is the folder's only video, in `Subs/` / `Audio/` folders next to
 * it (and RARBG's `Subs/<name>/2_English.srt`); the other videos (`kind`:
 * `episode` (it names an episode), `extra`, `video`).
 */
function companions(files, video) {
  var all = files || [],
    videoParts = parts(video.path),
    dir = videoParts.slice(0, -1).join('/'),
    base = stem(videoParts[videoParts.length - 1]),
    lower = base.toLowerCase(),
    videosHere = all.filter(function (f) {
      return kindOf(f.path) === 'video' && parts(f.path).slice(0, -1).join('/') === dir && !extra(f);
    }).length,
    alone = videosHere <= 1,
    found = { audio: [], subtitles: [], videos: [] };

  all.forEach(function (f) {
    if (f === video || f.path === video.path) {
      return;
    }
    var kind = kindOf(f.path);
    if (kind === 'video') {
      if (sample(f)) {
        return;
      }
      found.videos.push(Object.assign({}, f, {
        kind: extra(f) ? 'extra' : /\bs\d{1,2}[ ._-]*e\d{1,3}|\b\d{1,2}x\d{2,3}\b/i.test(path.basename(f.path)) ? 'episode' : 'video'
      }));
      return;
    }
    if (!kind) {
      return;
    }
    var p = parts(f.path),
      name = p[p.length - 1],
      own = stem(name),
      fileDir = p.slice(0, -1),
      rest = null;
    if (fileDir.join('/') === dir) {
      // next to it: named after it, or the folder's only video
      if (own.toLowerCase() === lower || own.toLowerCase().indexOf(lower + '.') === 0) {
        rest = own.slice(base.length);
      } else if (alone) {
        rest = own;
      }
    } else if (fileDir.slice(0, -1).join('/') === dir &&
      (kind === 'subtitle' ? SUBS_DIR : AUDIO_DIR).test(fileDir[fileDir.length - 1])) {
      // Subs/ (or Audio/) next to it: named after it, or anything when it is alone
      if (own.toLowerCase().indexOf(lower) === 0) {
        rest = own.slice(base.length);
      } else if (alone) {
        rest = own;
      }
    } else if (kind === 'subtitle' && fileDir.length >= 2 && fileDir.slice(0, -2).join('/') === dir &&
      SUBS_DIR.test(fileDir[fileDir.length - 2]) && fileDir[fileDir.length - 1].toLowerCase() === lower) {
      // RARBG: Subs/<video name>/2_English.srt
      rest = own;
    }
    if (rest === null) {
      return;
    }
    var described = describeSub(f.path, rest);
    if (kind === 'subtitle') {
      // VobSub: the .idx stands for the pair
      if (/\.sub$/i.test(name) && all.some(function (o) { return o.path === f.path.replace(/\.sub$/i, '.idx'); })) {
        return;
      }
      found.subtitles.push(Object.assign({}, f, { language: described.language, forced: described.forced, sdh: described.sdh }));
    } else {
      found.audio.push(Object.assign({}, f, { language: described.language, label: rest.replace(/^[._\s-]+/, '').replace(/[._]+/g, ' ').trim() || null }));
    }
  });
  return found;
}

module.exports = {
  kindOf: kindOf,
  choose: choose,
  companions: companions,
  extra: extra,
  VIDEO: VIDEO
};
