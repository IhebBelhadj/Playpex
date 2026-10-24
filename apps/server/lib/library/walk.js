'use strict';

// Lists a library folder's video files (docs/media-server-plan.md §5.2):
// video extensions only, no hidden files, no extras folders, no samples
// (< 100 MB with "sample" in the name). A symlink is followed only when its
// realpath stays inside a library folder (`roots`), each directory once.
// fs.promises runs on libuv's threads: the event loop stays free.
//
//   walk(root, roots) → Promise<{ files: [{ relPath, size, mtime, subtitles, nfo }], missing }>
//   missing: the folder itself can't be read (an unplugged drive)
//
// Next to each video: its sidecar subtitles (`Movie.en.srt`, `Movie.srt`,
// `Subs/…`, RARBG's `Subs/<name>/2_English.srt`) and the .nfo files that may
// describe it (`<name>.nfo`, `movie.nfo`, `tvshow.nfo` up the tree).

var fs = require('fs'),
  path = require('path'),
  languages = require('../subtitles/languages');

var VIDEO = /\.(mkv|mp4|m4v|avi|webm|mov|ts|m2ts|wmv)$/i,
  SUBTITLE = /\.(srt|vtt)$/i,
  SUBS_DIR = /^(subs|subtitles)$/i,
  EXTRAS_DIR = /^(extras?|featurettes?|behind the scenes|deleted scenes|interviews|scenes|shorts|trailers?|samples?|other|bonus)$/i,
  SAMPLE_BYTES = 100 * 1024 * 1024,
  MAX_DEPTH = 12;

function inside(real, roots) {
  return roots.some(function (root) {
    return real === root || real.indexOf(root + path.sep) === 0;
  });
}

// "en", "eng", "English", "2_English" → { code, name } | null
function language(token) {
  var raw = String(token).replace(/^\d+_/, ''),
    info = languages.normalize(raw);
  return info.code === raw.toLowerCase() && info.name === raw ? null : { code: info.code, name: info.name };
}

// The sidecar's language and flags from what follows the video's name
function describeSub(relPath, rest) {
  var tokens = rest.split(/[._\s-]+/).filter(Boolean),
    lang = null;
  tokens.forEach(function (t) { lang = lang || language(t); });
  return {
    relPath: relPath,
    language: lang ? lang.code : null,
    forced: tokens.some(function (t) { return /^forced$/i.test(t); }),
    sdh: tokens.some(function (t) { return /^(sdh|cc|hi)$/i.test(t); })
  };
}

/**
 * @param {string} root   the folder's realpath
 * @param {string[]} roots every library folder's realpath (where symlinks may lead)
 */
function walk(root, roots) {
  var dirs = {},          // rel dir → { videos: [{name, size, mtime}], subs: [names], nfo: [names], children: [names] }
    seen = new Set();

  function rel(dir, name) {
    return dir ? dir + '/' + name : name;
  }

  function visit(dir, depth) {
    var full = dir ? path.join(root, dir.split('/').join(path.sep)) : root;
    return fs.promises.realpath(full).then(function (real) {
      if (seen.has(real) || depth > MAX_DEPTH) {
        return;
      }
      seen.add(real);
      return fs.promises.readdir(full, { withFileTypes: true }).then(function (entries) {
        var here = dirs[dir] = { videos: [], subs: [], nfo: [], children: [] };
        return entries.reduce(function (chain, entry) {
          return chain.then(function () { return visitEntry(dir, depth, full, here, entry); });
        }, Promise.resolve());
      });
    });
  }

  function visitEntry(dir, depth, full, here, entry) {
    var name = entry.name,
      target = path.join(full, name);
    if (name[0] === '.' || name === '@eaDir' || name === '$RECYCLE.BIN') {
      return Promise.resolve();
    }
    var kind = entry.isSymbolicLink() ?
      fs.promises.realpath(target).then(function (real) {
        return inside(real, roots) ? fs.promises.stat(real) : null;
      }).catch(function () { return null; }) :
      Promise.resolve(entry.isDirectory() || entry.isFile() ? entry : null);
    return kind.then(function (what) {
      if (!what) {
        return;
      }
      if (what.isDirectory()) {
        if (EXTRAS_DIR.test(name) && !SUBS_DIR.test(name)) {
          return;
        }
        here.children.push(name);
        return visit(rel(dir, name), depth + 1).catch(function () {});
      }
      if (SUBTITLE.test(name)) {
        here.subs.push(name);
      } else if (/\.nfo$/i.test(name)) {
        here.nfo.push(name);
      } else if (VIDEO.test(name)) {
        return (what.size !== undefined ? Promise.resolve(what) : fs.promises.stat(target)).then(function (st) {
          if (st.size < SAMPLE_BYTES && /\bsample\b/i.test(name)) {
            return;
          }
          here.videos.push({ name: name, size: st.size, mtime: new Date(Math.floor(st.mtimeMs)) });
        }, function () {});
      }
    });
  }

  function subtitlesOf(dir, video, alone) {
    var base = video.name.replace(/\.[^.]+$/, ''),
      lower = base.toLowerCase(),
      here = dirs[dir],
      found = [];
    here.subs.forEach(function (name) {
      var stem = name.replace(SUBTITLE, '');
      if (stem.toLowerCase() === lower || stem.toLowerCase().indexOf(lower + '.') === 0) {
        found.push(describeSub(rel(dir, name), stem.slice(base.length)));
      } else if (alone) {
        found.push(describeSub(rel(dir, name), stem));
      }
    });
    here.children.filter(function (c) { return SUBS_DIR.test(c); }).forEach(function (subsDir) {
      var subsRel = rel(dir, subsDir), subs = dirs[subsRel];
      if (!subs) {
        return;
      }
      subs.subs.forEach(function (name) {
        var stem = name.replace(SUBTITLE, '');
        if (alone || stem.toLowerCase().indexOf(lower) === 0) {
          found.push(describeSub(rel(subsRel, name), stem.toLowerCase().indexOf(lower) === 0 ? stem.slice(base.length) : stem));
        }
      });
      // RARBG: Subs/<video name>/2_English.srt
      var own = subs.children.filter(function (c) { return c.toLowerCase() === lower; })[0],
        ownSubs = own && dirs[rel(subsRel, own)];
      (ownSubs ? ownSubs.subs : []).forEach(function (name) {
        found.push(describeSub(rel(rel(subsRel, own), name), name.replace(SUBTITLE, '')));
      });
    });
    return found;
  }

  // .nfo files that may describe the video, nearest first
  function nfoOf(dir, video, alone) {
    var base = video.name.replace(/\.[^.]+$/, '').toLowerCase(),
      found = [],
      parts = dir ? dir.split('/') : [];
    dirs[dir].nfo.forEach(function (name) {
      var stem = name.replace(/\.nfo$/i, '').toLowerCase();
      // its own, or any but tvshow.nfo when it is the folder's only video (movie.nfo…)
      if (stem === base || alone && stem !== 'tvshow') {
        found.push(rel(dir, name));
      }
    });
    // tvshow.nfo here or up to two folders up (Show/Season 1/…)
    for (var up = 0; up <= 2 && up <= parts.length; up++) {
      var d = parts.slice(0, parts.length - up).join('/'),
        there = dirs[d];
      (there ? there.nfo : []).forEach(function (name) {
        if (/^tvshow\.nfo$/i.test(name)) {
          found.push(rel(d, name));
        }
      });
    }
    return found;
  }

  return fs.promises.stat(root).then(function (st) {
    if (!st.isDirectory()) {
      throw new Error('not a folder');
    }
    return visit('', 0);
  }).then(function () {
    var files = [];
    Object.keys(dirs).sort().forEach(function (dir) {
      var here = dirs[dir];
      if (!here) {
        return;
      }
      var alone = here.videos.length === 1;
      here.videos.forEach(function (video) {
        files.push({
          relPath: rel(dir, video.name),
          size: video.size,
          mtime: video.mtime,
          subtitles: subtitlesOf(dir, video, alone),
          nfo: nfoOf(dir, video, alone)
        });
      });
    });
    return { files: files, missing: false };
  }, function () {
    return { files: [], missing: true };
  });
}

module.exports = walk;
// a sidecar's language and flags (lib/media/files.js reads a torrent's the same way)
module.exports.describeSub = describeSub;
