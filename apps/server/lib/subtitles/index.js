'use strict';

// Subtitle provider registry. Each provider module exports:
//   id, name, description, supports: {movie, episode}, isConfigured(),
//   search(query) -> [{ref, language, name}], fetch(ref) -> {buffer, format}
// where query = { imdbId: 'tt…', season?, episode? }.
// Add a provider by writing a module in ./providers and listing it here
// (order = order shown in the player; the first configured one is the default).
// Plugins with `subtitles.providers` follow them (./plugins.js, `plugin:<id>`).

var languages = require('./languages'),
  pluginSubs = require('./plugins');

var PROVIDERS = [
  require('./providers/stremio-opensubtitles'),
  require('./providers/yify'),
  require('./providers/opensubtitles'),
  require('./providers/wyzie')
];

function get(id) {
  return PROVIDERS.find(function (p) {
    return p.id === id;
  });
}

function list() {
  return PROVIDERS.map(function (p) {
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      supports: p.supports,
      enabled: p.isConfigured()
    };
  }).concat(pluginSubs.list());
}

// A plugin's provider as a module of ./providers (search, fetch)
function pluginProvider(id) {
  return {
    id: id,
    name: id,
    supports: { movie: true, episode: true },
    isConfigured: function () { return true; },
    search: function (query, filter) {
      return pluginSubs.search(id, query, filter ? Array.from(filter) : []);
    },
    fetch: function (ref) {
      return pluginSubs.fetch(id, ref);
    }
  };
}

function defaultProvider() {
  return PROVIDERS.find(function (p) {
    return p.isConfigured();
  });
}

function search(providerId, query, languageFilter) {
  var provider = pluginSubs.isPlugin(providerId) ? pluginProvider(providerId) : providerId ? get(providerId) : defaultProvider();
  if (!provider) {
    return Promise.reject(new Error('unknown subtitle provider ' + providerId));
  }
  if (!provider.isConfigured()) {
    return Promise.reject(new Error(provider.name + ' needs an API key'));
  }
  var kind = query.season ? 'episode' : 'movie';
  if (!provider.supports[kind]) {
    return Promise.resolve({ provider: provider.id, subtitles: [], unsupported: true });
  }

  var filter = languages.parseFilter(languageFilter);
  return provider.search(query, filter).then(function (results) {
    var subtitles = results.map(function (s) {
      var lang = languages.normalize(s.language);
      return {
        provider: provider.id,
        ref: s.ref,
        language: lang.code,
        languageName: lang.name,
        name: s.name
      };
    }).filter(function (s) {
      return !filter || filter.has(s.language);
    });
    return { provider: provider.id, subtitles: subtitles };
  });
}

function decode(buffer, language) {
  var bytes = buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF ? buffer.subarray(3) : buffer;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (e) {
    // Older SRTs use the language's Windows code page
    try {
      return new TextDecoder(languages.normalize(language).codePage).decode(bytes);
    } catch (unsupported) {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }
}

// h:mm:ss.cc (ASS) → hh:mm:ss.mmm
function assTime(t) {
  var m = /^(\d+):(\d{2}):(\d{2})[.,](\d{2,3})$/.exec(t.trim());
  if (!m) {
    return null;
  }
  return ('0' + m[1]).slice(-2) + ':' + m[2] + ':' + m[3] + '.' + (m[4] + '0').slice(0, 3);
}

// SubStation Alpha (.ass / .ssa) → WebVTT cues: the Dialogue lines' text,
// without their styles and override tags
function assToVtt(text) {
  var format = null, cues = [];
  text.split('\n').forEach(function (line) {
    var f = /^Format:\s*(.*)$/i.exec(line);
    if (f && !format && /\btext\b/i.test(f[1]) && /\bstart\b/i.test(f[1])) {
      format = f[1].split(',').map(function (x) { return x.trim().toLowerCase(); });
      return;
    }
    var d = /^Dialogue:\s*(.*)$/i.exec(line);
    if (!d || !format) {
      return;
    }
    var parts = d[1].split(','),
      fields = parts.slice(0, format.length - 1).concat(parts.slice(format.length - 1).join(',')),
      start = assTime(fields[format.indexOf('start')] || ''),
      end = assTime(fields[format.indexOf('end')] || ''),
      body = (fields[format.indexOf('text')] || '').replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ').trim();
    if (start && end && body) {
      cues.push(start + ' --> ' + end + '\n' + body);
    }
  });
  return 'WEBVTT\n\n' + cues.join('\n\n') + '\n';
}

function toVtt(text) {
  text = text.replace(/\r\n?/g, '\n').trim();
  if (/^WEBVTT/.test(text)) {
    return text + '\n';
  }
  if (/^\[Script Info\]/i.test(text)) {
    return assToVtt(text);
  }
  // SRT timestamps use a comma before milliseconds; WebVTT uses a dot
  return 'WEBVTT\n\n' + text.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2') + '\n';
}

// Returns the subtitle as a WebVTT string, ready for <track>
function file(providerId, ref, language) {
  var provider = pluginSubs.isPlugin(providerId) ? pluginProvider(providerId) : get(providerId);
  if (!provider || !provider.isConfigured()) {
    return Promise.reject(new Error('subtitle provider unavailable: ' + providerId));
  }
  return provider.fetch(ref).then(function (result) {
    return toVtt(decode(result.buffer, language));
  });
}

module.exports = {
  list: list,
  search: search,
  file: file,
  // a subtitle file's bytes → WebVTT text (lib/routes/media.js: sidecar files)
  toVtt: function (buffer, language) { return toVtt(decode(buffer, language)); }
};
