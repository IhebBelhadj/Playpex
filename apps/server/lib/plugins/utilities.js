'use strict';

// Host utilities for source plugins (docs/providers-plan.md §4.2): what the
// core knows about release names, HTML and .torrent files, so a plugin needs
// no parser of its own (and doesn't spend its 2 s of CPU parsing HTML in
// QuickJS). Pure and in-process, no permission needed; rate limited per
// plugin like the core data calls (LIMITS.core).
//
//   names.parse ({ name })            lib/media/names#parse
//   names.describe ({ name })         { quality, codec, audio, playable }
//   names.matches ({ name, title })   'episode' | 'pack' | 'movie' | null for a titleRef (a list of names: a list)
//   names.rank ({ items })            the items in the core's streaming order
//   html.select ({ html, selector, fields? })   the matches' text / attributes, or the fields of each
//   torrent.info (bytes)              a .torrent's { infoHash, name, size, pieceLength, files }
//
// Errors: INVALID (bad arguments, a selector that doesn't parse, bytes that
// aren't a torrent), RATE_LIMITED.

var protocol = require('@playpex/protocol/plugins'),
  htmlParser = require('node-html-parser'),
  parseTorrent = require('parse-torrent'),
  names = require('../media/names'),
  schemas = require('./schemas'),
  RateLimiter = require('./ratelimit');

var NAME_MAX = 1000,
  RANK_MAX = 1000,
  HTML_MAX = 4 * 1024 * 1024,
  SELECTOR_MAX = 500,
  FIELDS_MAX = 30,
  MATCHES_MAX = 500,
  TEXT_MAX = 10000,
  TORRENT_MAX = 4 * 1024 * 1024;

var limiter = new RateLimiter();

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function invalid(message) {
  return failure('INVALID', message);
}

function nameOf(args) {
  if (typeof args.name !== 'string' || args.name.length > NAME_MAX) {
    throw invalid('name: a string (≤ ' + NAME_MAX + ' characters)');
  }
  return args.name;
}

function text(node) {
  return node.text.replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
}

// 'a.title' → its text, 'a.title@href' → its attribute, '@href' → the match's own, '' → its own text
function field(node, spec) {
  var at = spec.lastIndexOf('@'),
    css = (at === -1 ? spec : spec.slice(0, at)).trim(),
    attribute = at === -1 ? null : spec.slice(at + 1).trim(),
    target = css ? node.querySelector(css) : node;
  if (!target) {
    return null;
  }
  if (attribute) {
    var value = target.getAttribute(attribute);
    return value === undefined || value === null ? null : String(value).slice(0, TEXT_MAX);
  }
  return text(target);
}

function attributes(node) {
  var out = {};
  Object.keys(node.attributes || {}).slice(0, 50).forEach(function (k) {
    out[k] = String(node.attributes[k]).slice(0, TEXT_MAX);
  });
  return out;
}

function select(args) {
  if (typeof args.html !== 'string') {
    throw invalid('html: a string');
  }
  if (Buffer.byteLength(args.html) > HTML_MAX) {
    throw invalid('html: at most 4 MB');
  }
  if (typeof args.selector !== 'string' || !args.selector.trim() || args.selector.length > SELECTOR_MAX) {
    throw invalid('selector: a CSS selector (≤ ' + SELECTOR_MAX + ' characters)');
  }
  var fields = args.fields;
  if (fields !== null && fields !== undefined) {
    if (typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length > FIELDS_MAX ||
      Object.keys(fields).some(function (k) { return typeof fields[k] !== 'string' || fields[k].length > SELECTOR_MAX; })) {
      throw invalid('fields: { name: \'selector\' | \'selector@attribute\' | \'@attribute\' } (≤ ' + FIELDS_MAX + ')');
    }
  }
  var found;
  try {
    found = htmlParser.parse(args.html).querySelectorAll(args.selector).slice(0, MATCHES_MAX);
    return found.map(function (node) {
      if (!fields) {
        return { text: text(node), attributes: attributes(node) };
      }
      var out = {};
      Object.keys(fields).forEach(function (k) { out[k] = field(node, fields[k]); });
      return out;
    });
  } catch (err) {
    throw invalid('selector: ' + String(err && err.message || err).slice(0, 200));
  }
}

function torrentInfo(bytes) {
  if (!bytes || !bytes.length) {
    throw invalid('torrent.info needs the .torrent file\'s bytes');
  }
  if (bytes.length > TORRENT_MAX) {
    throw invalid('a .torrent of at most 4 MB');
  }
  var parsed;
  try {
    parsed = parseTorrent(Buffer.from(bytes));
  } catch (err) {
    parsed = null;
  }
  if (!parsed || !parsed.infoHash || !Array.isArray(parsed.files)) {
    throw invalid('these bytes aren\'t a .torrent file');
  }
  return {
    infoHash: parsed.infoHash.toLowerCase(),
    name: String(parsed.name || ''),
    size: parsed.length || 0,
    pieceLength: parsed.pieceLength || null,
    files: parsed.files.slice(0, 10000).map(function (f, i) {
      return { index: i, path: String(f.path).split('\\').join('/'), size: f.length };
    })
  };
}

/**
 * @param {object} plugin  { id, stats }
 */
module.exports = function utilities(plugin) {
  function count(key) {
    plugin.stats.host[key] = (plugin.stats.host[key] || 0) + 1;
  }

  // One call inside this plugin's share (the CPU is the server's)
  function limited(service, work) {
    count(service);
    return limiter.acquire(plugin.id + ' ' + service, protocol.LIMITS.core).then(function (release) {
      try {
        var value = work();
        release();
        return { value: value };
      } catch (err) {
        release();
        count(service + '.' + (err.code || 'error'));
        throw err;
      }
    });
  }

  return {
    'names.parse': function (args) {
      var name = nameOf(args);
      return limited('names', function () { return names.parse(name); });
    },
    'names.describe': function (args) {
      var name = nameOf(args);
      return limited('names', function () { return names.describe(name); });
    },
    // a list of names (≤ RANK_MAX) answers a list, for one call's share
    'names.matches': function (args) {
      var list = Array.isArray(args.name), problem = schemas.apiProblem('titleRef', args.title), all;
      try {
        all = list ? args.name.map(function (name) { return nameOf({ name: name }); }) : [nameOf(args)];
      } catch (err) {
        return Promise.reject(err);
      }
      if (all.length > RANK_MAX) {
        return Promise.reject(invalid('name: at most ' + RANK_MAX + ' names'));
      }
      if (problem) {
        return Promise.reject(invalid('title: ' + problem));
      }
      return limited('names', function () {
        var found = all.map(function (name) { return names.matches(name, args.title); });
        return list ? found : found[0];
      });
    },
    'names.rank': function (args) {
      var items = args.items;
      if (!Array.isArray(items) || items.length > RANK_MAX || items.some(function (i) {
        return !i || typeof i !== 'object' || Array.isArray(i) || typeof i.name !== 'string';
      })) {
        return Promise.reject(invalid('items: a list (≤ ' + RANK_MAX + ') of objects with a name'));
      }
      return limited('names', function () { return names.rank(items); });
    },
    'html.select': function (args) {
      return limited('html', function () { return select(args); });
    },
    'torrent.info': function (args, bytes) {
      return limited('torrent', function () { return torrentInfo(bytes); });
    }
  };
};

module.exports.reset = function () {
  limiter.reset();
};
