'use strict';

// Providers report languages as ISO 639-2 ("eng", "pob"), ISO 639-1 ("en")
// or English names ("English"). Everything is normalized to ISO 639-1 so the
// player can filter and set <track srclang>.

var LANGUAGES = [
  // [639-1, 639-2 codes..., English name, legacy Windows code page for non-UTF-8 files]
  ['en', ['eng'], 'English', 'windows-1252'],
  ['ar', ['ara'], 'Arabic', 'windows-1256'],
  ['de', ['ger', 'deu'], 'German', 'windows-1252'],
  ['es', ['spa', 'spl', 'spn', 'ea'], 'Spanish', 'windows-1252'],
  ['fr', ['fre', 'fra'], 'French', 'windows-1252'],
  ['it', ['ita'], 'Italian', 'windows-1252'],
  ['pt', ['por', 'pob', 'pb', 'pt-br'], 'Portuguese', 'windows-1252'],
  ['nl', ['dut', 'nld'], 'Dutch', 'windows-1252'],
  ['tr', ['tur'], 'Turkish', 'windows-1254'],
  ['ru', ['rus'], 'Russian', 'windows-1251'],
  ['pl', ['pol'], 'Polish', 'windows-1250'],
  ['cs', ['cze', 'ces'], 'Czech', 'windows-1250'],
  ['ro', ['rum', 'ron'], 'Romanian', 'windows-1250'],
  ['hu', ['hun'], 'Hungarian', 'windows-1250'],
  ['hr', ['hrv'], 'Croatian', 'windows-1250'],
  ['sr', ['srp', 'scc'], 'Serbian', 'windows-1250'],
  ['bg', ['bul'], 'Bulgarian', 'windows-1251'],
  ['el', ['gre', 'ell'], 'Greek', 'windows-1253'],
  ['he', ['heb'], 'Hebrew', 'windows-1255'],
  ['fa', ['per', 'fas'], 'Persian', 'windows-1256'],
  ['sv', ['swe'], 'Swedish', 'windows-1252'],
  ['da', ['dan'], 'Danish', 'windows-1252'],
  ['no', ['nor', 'nob'], 'Norwegian', 'windows-1252'],
  ['fi', ['fin'], 'Finnish', 'windows-1252'],
  ['id', ['ind'], 'Indonesian', 'windows-1252'],
  ['ms', ['may', 'msa'], 'Malay', 'windows-1252'],
  ['vi', ['vie'], 'Vietnamese', 'windows-1258'],
  ['th', ['tha'], 'Thai', 'windows-874'],
  ['zh', ['chi', 'zho', 'zht', 'zhe'], 'Chinese', 'gbk'],
  ['ja', ['jpn'], 'Japanese', 'shift_jis'],
  ['ko', ['kor'], 'Korean', 'euc-kr'],
  ['hi', ['hin'], 'Hindi', 'utf-8'],
  ['bn', ['ben'], 'Bengali', 'utf-8'],
  ['uk', ['ukr'], 'Ukrainian', 'windows-1251'],
  ['sk', ['slo', 'slk'], 'Slovak', 'windows-1250'],
  ['sl', ['slv'], 'Slovenian', 'windows-1250']
];

var byCode = {};
LANGUAGES.forEach(function (entry) {
  var info = { code: entry[0], name: entry[2], codePage: entry[3] };
  [entry[0], entry[2].toLowerCase()].concat(entry[1]).forEach(function (alias) {
    byCode[alias] = info;
  });
});

// Returns { code, name, codePage }; unknown languages keep their raw code
function normalize(raw) {
  var key = String(raw || '').trim().toLowerCase();
  // "Brazilian Portuguese", "English (US)" -> first matching known word
  var info = byCode[key] || byCode[key.replace(/[^a-z]+.*$/, '')] || byCode[key.split(/\s+/).pop()];
  if (info) {
    return info;
  }
  return { code: key || 'und', name: raw || 'Unknown', codePage: 'windows-1252' };
}

// languages: "en,ar,de" -> Set of codes, or null for "all"
function parseFilter(languages) {
  if (!languages) {
    return null;
  }
  var codes = String(languages).split(',').map(function (l) {
    return normalize(l).code;
  });
  return new Set(codes);
}

module.exports = {
  normalize: normalize,
  parseFilter: parseFilter
};
