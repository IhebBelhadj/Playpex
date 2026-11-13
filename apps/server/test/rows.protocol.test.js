'use strict';

// The rows registry (packages/protocol/rows.js, docs/rows-plan.md §3–§4): what a
// layout may hold, checked before the server stores one.

var test = require('node:test'),
  assert = require('node:assert/strict'),
  rows = require('@playpex/protocol/rows');

function entry(source, params, extra) {
  return Object.assign({ id: rows.newRowId(), source: source, params: params || {} }, extra);
}

test('a layout of every core source and plugin rows is valid', function () {
  var layout = [
    entry('core.continue'),
    entry('core.forYou', { mediaType: 'movie' }),
    entry('core.because', { count: 2 }),
    entry('core.list', { mediaType: 'movie', list: 'trending' }, { title: 'Top 10 today', variant: 'top10' }),
    entry('core.discover', { mediaType: 'tv', sort: 'popularity', minVotes: 100, recentYears: 2, withoutGenres: '10763,10764' }),
    entry('core.library', { order: 'added' }),
    entry('plugin', { plugin: 'st-cinemeta-ab12', row: 'c1a2b3c4d', values: { genre: 'Comedy' } }, { candidates: true }),
    entry('plugin.all', { plugin: 'trakt' }, { hideWatched: false })
  ];
  assert.deepEqual(rows.checkLayout('home', layout), []);
});

test('bad entries are refused with their place', function () {
  function problems(section, e) {
    return rows.checkLayout(section, [e]).join('\n');
  }
  assert.match(problems('home', entry('core.nothing')), /rows\[0\]: source must be one of/);
  assert.match(problems('home', entry('core.list', { mediaType: 'movie', list: 'airing_today' })), /list must be one of/);
  assert.match(problems('home', entry('core.list', { mediaType: 'movie' })), /params.list is required/);
  assert.match(problems('shows', entry('core.list', { mediaType: 'movie', list: 'popular' })), /movie rows don't go in shows/);
  assert.match(problems('home', entry('core.discover', { mediaType: 'tv', from: '2024-01-01', recentYears: 2 })), /from or recentYears/);
  assert.match(problems('home', entry('core.discover', { mediaType: 'tv', genres: 'drama' })), /genres is not valid/);
  assert.match(problems('home', entry('core.because', { count: 5 })), /between 1 and 3/);
  assert.match(problems('home', entry('core.forYou', {}, { candidates: true })), /candidates is for plugin rows/);
  assert.match(problems('home', entry('plugin', { plugin: 'trakt' })), /params.row is required/);
  assert.match(problems('home', entry('plugin', { plugin: 'trakt', row: 'x', values: { genre: 3 } })), /values.genre must be a text/);
  assert.match(problems('home', Object.assign(entry('core.forYou'), { id: 'nope' })), /id must be/);
  assert.match(problems('home', entry('core.forYou', {}, { title: '' })), /title must be/);
  assert.match(problems('home', entry('core.forYou', {}, { extra: 1 })), /unknown field extra/);
  var one = entry('core.forYou');
  assert.match(rows.checkLayout('home', [one, one]).join('\n'), /twice/);
  assert.match(rows.checkLayout('home', [entry('plugin.all', { plugin: 'trakt' }), entry('plugin.all', { plugin: 'trakt' })]).join('\n'), /trakt's rows twice/);
  assert.match(rows.checkLayout('kids', []).join('\n'), /section must be/);
  assert.match(rows.checkLayout('home', new Array(61).fill(0).map(function () { return entry('core.forYou'); })).join('\n'), /at most 60/);
});

test('default titles, and what hides watched titles', function () {
  assert.equal(rows.defaultTitle({ source: 'core.list', params: { mediaType: 'movie', list: 'trending' } }), 'Trending movies');
  assert.equal(rows.defaultTitle({ source: 'core.discover', params: { mediaType: 'tv', genres: '80' } }), 'Crime');
  assert.equal(rows.defaultTitle({ source: 'core.continue', params: {} }), 'Continue watching');
  assert.equal(rows.hidesWatched({ source: 'core.forYou' }), true);
  assert.equal(rows.hidesWatched({ source: 'core.list' }), false);
  assert.equal(rows.hidesWatched({ source: 'plugin' }, true), true, 'a personal offer');
  assert.equal(rows.hidesWatched({ source: 'core.forYou', hideWatched: false }), false, 'the entry decides');
  assert.match(rows.newRowId(), rows.ROW_ID);
});
