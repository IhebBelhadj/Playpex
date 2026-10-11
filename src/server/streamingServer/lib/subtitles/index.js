'use strict';

// Subtitle provider registry. Each provider module exports:
//   id, name, description, supports: {movie, episode}, isConfigured(),
//   search(query) -> [{ref, language, name}], fetch(ref) -> {buffer, format}
// where query = { imdbId: 'tt…', season?, episode? }.
// Add a provider by writing a module in ./providers and listing it here
// (order = order shown in the player; the first configured one is the default).

var languages = require('./languages');

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
  });
}

function defaultProvider() {
  return PROVIDERS.find(function (p) {
    return p.isConfigured();
  });
}

function search(providerId, query, languageFilter) {
  var provider = providerId ? get(providerId) : defaultProvider();
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
  return provider.search(query).then(function (results) {
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

function toVtt(text) {
  text = text.replace(/\r\n?/g, '\n').trim();
  if (/^WEBVTT/.test(text)) {
    return text + '\n';
  }
  // SRT timestamps use a comma before milliseconds; WebVTT uses a dot
  return 'WEBVTT\n\n' + text.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2') + '\n';
}

// Returns the subtitle as a WebVTT string, ready for <track>
function file(providerId, ref, language) {
  var provider = get(providerId);
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
  file: file
};
