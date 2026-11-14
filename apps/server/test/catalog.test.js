'use strict';

// The catalog clients browse (lib/catalog.js, /catalog/*; docs/providers-plan.md
// §7.1) on a real server with lib/tmdb.js#get stubbed (canned TMDB answers, no
// network): every answer in our shapes against openapi.yaml, the filters as
// TMDB parameters, include_adult never asked for, the language and region
// settings, TMDB's 404 / failures in our words, bad parameters refused before
// any call.

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  YAML = require('yaml'),
  Ajv2020 = require('ajv/dist/2020');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-catalog-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  settings = require('../lib/settings'),
  tmdb = require('../lib/tmdb');

var base = null,
  calls = [];

var ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(YAML.parse(fs.readFileSync(require.resolve('@playpex/protocol/openapi.yaml'), 'utf8')), 'spec');

function conforms(schema, value) {
  var validate = ajv.getSchema('spec#/components/schemas/' + schema);
  assert.ok(validate(value), schema + ': ' + ajv.errorsText(validate.errors));
}

// ── a canned TMDB ───────────────────────────────────────────────────────────

var HEAT = {
  id: 949, title: 'Heat', original_title: 'Heat', release_date: '1995-12-15', overview: 'Cops and robbers.',
  poster_path: '/heat.jpg', backdrop_path: '/heat-bd.jpg', genre_ids: [28, 80], vote_average: 7.9, vote_count: 7000,
  original_language: 'en'
};
var BREAKING_BAD = {
  id: 1396, name: 'Breaking Bad', original_name: 'Breaking Bad', first_air_date: '2008-01-20', overview: 'Chemistry.',
  poster_path: '/bb.jpg', backdrop_path: null, genre_ids: [18], vote_average: 8.9, vote_count: 15000, original_language: 'en'
};

function list(results) {
  return { page: 1, total_pages: 900, total_results: 18000, results: results };
}

var ANSWERS = {
  '/movie/popular': list([HEAT]),
  '/discover/tv': list([BREAKING_BAD]),
  '/genre/movie/list': { genres: [{ id: 28, name: 'Action' }] },
  '/search/multi': list([
    Object.assign({ media_type: 'movie' }, HEAT),
    Object.assign({ media_type: 'tv' }, BREAKING_BAD),
    { media_type: 'person', id: 1158, name: 'Al Pacino', profile_path: '/al.jpg', known_for_department: 'Acting',
      known_for: [Object.assign({ media_type: 'movie' }, HEAT), { media_type: 'collection', id: 5 }] },
    { media_type: 'collection', id: 5 }
  ]),
  '/movie/949': Object.assign({}, HEAT, {
    imdb_id: 'tt0113277', runtime: 170, tagline: 'A Los Angeles crime saga', status: 'Released',
    genres: [{ id: 28, name: 'Action' }, { id: 80, name: 'Crime' }],
    videos: { results: [{ key: 'abc', name: 'Official Trailer', site: 'YouTube', type: 'Trailer', official: true }] }
  }),
  '/tv/1396': Object.assign({}, BREAKING_BAD, {
    external_ids: { imdb_id: 'tt0903747' }, episode_run_time: [47], number_of_seasons: 5, number_of_episodes: 62,
    genres: [{ id: 18, name: 'Drama' }], videos: { results: [] },
    seasons: [{ season_number: 0, name: 'Specials', episode_count: 9, air_date: '' }, { season_number: 1, name: 'Season 1', episode_count: 7, air_date: '2008-01-20', poster_path: '/s1.jpg' }]
  }),
  '/movie/949/credits': {
    cast: [{ id: 1158, name: 'Al Pacino', character: 'Vincent Hanna', profile_path: '/al.jpg', credit_id: 'c1', order: 0 }],
    crew: [{ id: 638, name: 'Michael Mann', job: 'Director', department: 'Directing', credit_id: 'c2' }]
  },
  '/movie/949/similar': list([HEAT]),
  '/tv/1396/season/1': {
    season_number: 1, name: 'Season 1', overview: '', air_date: '2008-01-20', poster_path: '/s1.jpg',
    episodes: [{
      season_number: 1, episode_number: 1, name: 'Pilot', air_date: '2008-01-20', runtime: 58, still_path: '/p.jpg', vote_average: 8.4,
      vote_count: 300, crew: [{ id: 66633, name: 'Vince Gilligan', job: 'Director', department: 'Directing', credit_id: 'e1' }],
      guest_stars: [{ id: 1, name: 'Someone', character: 'Krazy-8', credit_id: 'g1', order: 500 }]
    }, { season_number: 1, episode_number: 2, name: 'TBA', air_date: null }]
  },
  '/person/17419': {
    id: 17419, name: 'Bryan Cranston', profile_path: '/bc.jpg', known_for_department: 'Acting', biography: '',
    birthday: '1956-03-07', deathday: null, place_of_birth: 'Hollywood, California, USA', imdb_id: 'nm0186505',
    combined_credits: {
      cast: [
        Object.assign({ media_type: 'tv', character: 'Walter White', episode_count: 62, order: 0 }, BREAKING_BAD),
        Object.assign({ media_type: 'movie', character: 'Someone', order: 12 }, HEAT),
        { media_type: 'tv', id: 2, name: 'Late Night', genre_ids: [10767], character: 'Self', poster_path: '/ln.jpg', vote_count: 900 },
        { media_type: 'movie', id: 3, title: 'No Poster', genre_ids: [18], character: 'Bob', vote_count: 1 }
      ],
      crew: [
        Object.assign({ media_type: 'tv', job: 'Director', department: 'Directing', episode_count: 3 }, BREAKING_BAD),
        Object.assign({ media_type: 'tv', job: 'Producer', department: 'Production' }, BREAKING_BAD)
      ]
    }
  },
  '/person/99': {
    id: 99, name: 'A Host', profile_path: null, known_for_department: 'Acting', biography: 'Hosts things.',
    combined_credits: { cast: [{ media_type: 'tv', id: 2, name: 'Late Night', genre_ids: [10767], character: 'Self - Host', poster_path: '/ln.jpg' }], crew: [] }
  },
  '/person/1158/combined_credits': {
    cast: [Object.assign({ media_type: 'movie', character: 'Vincent Hanna' }, HEAT)],
    crew: [Object.assign({ media_type: 'tv', job: 'Producer', department: 'Production' }, BREAKING_BAD)]
  }
};

tmdb.get = function (apiPath, params, options) {
  calls.push({ path: apiPath, params: params, options: options });
  if (apiPath === '/person/17419' && params.language === 'en-US' && settings.get('metadata.language') !== 'en-US') {
    return Promise.resolve({ id: 17419, biography: 'Bryan Lee Cranston is an American actor.' });
  }
  if (apiPath === '/movie/404' || apiPath === '/person/404') {
    return Promise.reject(Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } }));
  }
  if (apiPath === '/movie/500') {
    return Promise.reject(Object.assign(new Error('Request failed with status code 500 api_key=secret'), { response: { status: 500 } }));
  }
  var answer = ANSWERS[apiPath];
  return answer ? Promise.resolve(JSON.parse(JSON.stringify(answer))) : Promise.reject(new Error('no canned answer for ' + apiPath));
};

function get(url, expected) {
  return new Promise(function (resolve, reject) {
    http.get(new URL('/api/v1' + url, base), { agent: false }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (res.statusCode !== (expected || 200)) {
          return reject(new Error(url + ' → ' + res.statusCode + ' ' + JSON.stringify(body)));
        }
        resolve(body);
      });
    }).on('error', reject);
  });
}

function last() {
  return calls[calls.length - 1];
}

test.before(function () {
  return server.start({ port: 0, console: false, library: false, plugins: false, torrents: { engine: 'fake', discovery: false } })
    .then(function (info) { base = 'http://127.0.0.1:' + info.port; });
});

test.after(function () {
  return server.stop();
});

test('the built-in key: a fresh server has a catalog', function () {
  assert.equal(tmdb.configured(), true);
  assert.equal(tmdb.builtInKey(), !settings.get('providers.tmdbApiKey'), 'the repo\'s .env may set one');
  return get('/catalog').then(function (body) {
    conforms('CatalogInfo', body);
    assert.deepEqual(body, { provider: 'tmdb', imageBase: 'https://image.tmdb.org/t/p/', language: 'en-US', region: null });
  });
});

test('lists, genres, search: our shapes, cached an hour, in the catalog\'s language', function () {
  return get('/catalog/lists/movie/popular?page=2').then(function (body) {
    conforms('CatalogPage', body);
    assert.equal(body.totalPages, 500, 'TMDB serves no page past 500');
    assert.deepEqual(body.results[0], {
      mediaType: 'movie', tmdbId: 949, title: 'Heat', originalTitle: 'Heat', releaseDate: '1995-12-15', year: '1995',
      overview: 'Cops and robbers.', posterPath: '/heat.jpg', backdropPath: '/heat-bd.jpg', genreIds: [28, 80],
      voteAverage: 7.9, voteCount: 7000, originalLanguage: 'en'
    });
    assert.deepEqual(last(), { path: '/movie/popular', params: { language: 'en-US', page: 2 }, options: { ttl: 3600000 } });
    return get('/catalog/genres/movie');
  }).then(function (body) {
    assert.deepEqual(body, { genres: [{ id: 28, name: 'Action' }] });
    return get('/catalog/search/multi?q=' + encodeURIComponent(' heat '));
  }).then(function (body) {
    conforms('CatalogPage', body);
    assert.deepEqual(body.results.map(function (r) { return r.mediaType; }), ['movie', 'tv', 'person'], 'a collection is left out');
    assert.deepEqual(body.results[2], {
      mediaType: 'person', personId: 1158, name: 'Al Pacino', profilePath: '/al.jpg', knownForDepartment: 'Acting',
      knownFor: [{ mediaType: 'movie', tmdbId: 949, title: 'Heat' }]
    });
    assert.equal(body.results[1].title, 'Breaking Bad');
    assert.deepEqual(last().params, { language: 'en-US', query: 'heat', page: 1, include_adult: false });
  });
});

test('discover: our filters as TMDB\'s, never adult titles', function () {
  return get('/catalog/discover/tv?sort=newest&genres=18&withoutGenres=10763,10764,10767&language=en&minVotes=100&minRating=7&from=2020-01-01&to=2029-12-31&page=3')
    .then(function (body) {
      conforms('CatalogPage', body);
      assert.deepEqual(last().params, {
        language: 'en-US', page: 3, sort_by: 'first_air_date.desc', include_adult: false, with_genres: '18',
        without_genres: '10763,10764,10767', with_original_language: 'en', 'vote_count.gte': '100', 'vote_average.gte': '7',
        'first_air_date.gte': '2020-01-01', 'first_air_date.lte': '2029-12-31'
      });
      return get('/catalog/discover/tv?sort=rating');
    }).then(function () {
      assert.equal(last().params.sort_by, 'vote_average.desc');
    });
});

test('a title\'s page, credits, similar titles, a season, a person', function () {
  return get('/catalog/titles/movie/949').then(function (movie) {
    conforms('CatalogDetails', movie);
    assert.equal(movie.imdbId, 'tt0113277');
    assert.equal(movie.runtime, 170);
    assert.deepEqual(movie.videos, [{ key: 'abc', name: 'Official Trailer', site: 'YouTube', type: 'Trailer', official: true }]);
    assert.equal(movie.seasons, undefined);
    assert.deepEqual(last().params, { language: 'en-US', append_to_response: 'external_ids,videos' });
    return get('/catalog/titles/tv/1396');
  }).then(function (show) {
    conforms('CatalogDetails', show);
    assert.deepEqual([show.imdbId, show.runtime, show.seasonCount, show.episodeCount], ['tt0903747', 47, 5, 62]);
    assert.deepEqual(show.seasons.map(function (s) { return [s.seasonNumber, s.airDate]; }), [[0, null], [1, '2008-01-20']]);
    return get('/catalog/titles/movie/949/credits');
  }).then(function (credits) {
    conforms('CatalogCredits', credits);
    assert.equal(credits.cast[0].character, 'Vincent Hanna');
    assert.equal(credits.crew[0].job, 'Director');
    return get('/catalog/titles/movie/949/similar');
  }).then(function (similar) {
    conforms('CatalogPage', similar);
    return get('/catalog/titles/tv/1396/seasons/1');
  }).then(function (season) {
    conforms('CatalogSeason', season);
    assert.equal(season.tmdbId, 1396);
    assert.deepEqual(season.episodes.map(function (e) { return [e.episodeNumber, e.airDate, e.runtime]; }), [[1, '2008-01-20', 58], [2, null, null]]);
    assert.equal(season.episodes[0].guestStars[0].character, 'Krazy-8');
    return get('/catalog/people/1158/credits');
  }).then(function (credits) {
    conforms('CatalogPersonCredits', credits);
    assert.equal(credits.cast[0].character, 'Vincent Hanna');
    assert.deepEqual([credits.crew[0].mediaType, credits.crew[0].job], ['tv', 'Producer']);
  });
});

test('a person\'s page: roles merged per title, appearances as themselves left out, known for', function () {
  return get('/catalog/people/17419').then(function (p) {
    conforms('CatalogPersonDetails', p);
    assert.deepEqual(last().params, { language: 'en-US', append_to_response: 'combined_credits,external_ids' });
    assert.deepEqual([p.name, p.birthday, p.deathday, p.placeOfBirth, p.imdbId], ['Bryan Cranston', '1956-03-07', null, 'Hollywood, California, USA', 'nm0186505']);
    assert.equal(p.biography, '', 'English already: no second call');
    assert.deepEqual(p.credits.map(function (c) { return c.mediaType + ':' + c.tmdbId; }), ['tv:1396', 'movie:949', 'movie:3'],
      'one entry per title, the talk show left out, no poster last');
    assert.deepEqual(p.credits[0].roles, [
      { character: 'Walter White' }, { job: 'Director', department: 'Directing' }, { job: 'Producer', department: 'Production' }
    ]);
    assert.deepEqual([p.credits[0].episodeCount, p.credits[0].order], [62, 0]);
    assert.deepEqual(p.knownFor, [1396, 949]);
    settings.update({ metadata: { language: 'fr-FR' } });
    return get('/catalog/people/17419');
  }).then(function (p) {
    assert.equal(p.biography, 'Bryan Lee Cranston is an American actor.', 'English when the language has none (decision C)');
    assert.equal(last().params.language, 'en-US');
    settings.update({ metadata: { language: 'en-US' } });
    return get('/catalog/people/99');
  }).then(function (p) {
    conforms('CatalogPersonDetails', p);
    assert.deepEqual(p.credits.map(function (c) { return c.tmdbId; }), [2], 'a host\'s page isn\'t empty');
    return get('/catalog/people/404', 404);
  }).then(function (body) {
    assert.equal(body.code, 'NOT_FOUND');
    assert.match(body.error, /person/);
    return get('/catalog/people/abc', 400);
  });
});

test('Settings › Metadata: the language for every call, the region for movie lists', function () {
  settings.update({ metadata: { language: 'fr-FR', region: 'FR' } });
  return get('/catalog/lists/movie/popular').then(function () {
    assert.deepEqual(last().params, { language: 'fr-FR', page: 1, region: 'FR' });
    return get('/catalog/discover/tv');
  }).then(function () {
    assert.equal(last().params.region, undefined, 'shows have no region');
    return get('/catalog');
  }).then(function (body) {
    assert.deepEqual([body.language, body.region], ['fr-FR', 'FR']);
    assert.throws(function () { settings.update({ metadata: { language: 'french' } }); }, /language code/);
    assert.throws(function () { settings.update({ metadata: { region: 'fr' } }); }, /country code/);
    settings.update({ metadata: { language: 'en-US', region: '' } });
  });
});

test('bad parameters refused before any call; TMDB\'s 404 and failures in our words', function () {
  var before = calls.length;
  return Promise.all([
    get('/catalog/lists/person/popular', 400),
    get('/catalog/lists/movie/airing_today', 400),
    get('/catalog/lists/movie/popular?page=501', 400),
    get('/catalog/discover/movie?genres=drama', 400),
    get('/catalog/discover/movie?sort=random', 400),
    get('/catalog/discover/movie?from=yesterday', 400),
    get('/catalog/search/collection?q=x', 400),
    get('/catalog/search/movie', 400),
    get('/catalog/titles/movie/abc', 400),
    get('/catalog/titles/tv/1396/seasons/x', 400)
  ]).then(function (answers) {
    answers.forEach(function (a) { assert.equal(a.code, 'INVALID'); });
    assert.equal(calls.length, before);
    return get('/catalog/titles/movie/404', 404);
  }).then(function (body) {
    assert.equal(body.code, 'NOT_FOUND');
    return get('/catalog/titles/movie/500', 502);
  }).then(function (body) {
    assert.deepEqual(body, { error: 'TMDB: HTTP 500', code: 'UPSTREAM' });
  });
});
