'use strict';

// The built-in layouts (docs/rows-plan.md §4): what a section shows before the
// admin sets a default. Movies and TV shows are the TV app's rows of before
// (apps/tv/src/app/categories.ts), Home the phone's, each after the personal
// rows (empty, so left out, for a profile with nothing watched yet). Ids are
// fixed so a profile's own copy keeps pointing at them.

function row(id, source, params, extra) {
  return Object.assign({ id: id, source: source, params: params || {} }, extra);
}

function movieGenre(id, genres, title) {
  return row(id, 'core.discover', { mediaType: 'movie', sort: 'popularity', genres: genres, language: 'en' }, { title: title });
}

// News, reality and talk shows left out: they rarely have anything to play
function tv(id, params, title) {
  return row(id, 'core.discover', Object.assign({ mediaType: 'tv', language: 'en', withoutGenres: '10763,10764,10767' }, params), { title: title });
}

var LAYOUTS = {
  home: [
    row('r_homeforyou', 'core.forYou'),
    row('r_homecontinue', 'core.continue'),
    row('r_homebecause', 'core.because', { count: 2 }),
    row('r_hometrendmov', 'core.list', { mediaType: 'movie', list: 'trending' }, { title: 'Trending movies' }),
    row('r_hometrendtv', 'core.list', { mediaType: 'tv', list: 'trending' }, { title: 'Trending shows' }),
    row('r_homecinemas', 'core.list', { mediaType: 'movie', list: 'now_playing' }, { title: 'New in cinemas' }),
    row('r_homelibrary', 'core.library', { order: 'added' }, { title: 'New on this server' }),
    row('r_hometoptv', 'core.list', { mediaType: 'tv', list: 'top_rated' }, { title: 'Top rated shows' }),
    row('r_homemylist', 'core.watchlist')
  ],
  movies: [
    row('r_movcontinue', 'core.continue', { mediaType: 'movie' }),
    row('r_movbecause', 'core.because', { mediaType: 'movie', count: 1 }),
    row('r_movtrending', 'core.list', { mediaType: 'movie', list: 'popular' }, { title: 'Trending' }),
    movieGenre('r_movanimated', '16', 'Animated movies'),
    row('r_movtoprated', 'core.list', { mediaType: 'movie', list: 'top_rated' }, { title: 'Top rated' }),
    movieGenre('r_movcomedy', '35', 'Comedy time'),
    movieGenre('r_movhorror', '27', 'Horror'),
    movieGenre('r_movaction', '28', 'Action'),
    movieGenre('r_movfamily', '10751', 'For family'),
    movieGenre('r_movwestern', '37', 'Western movies')
  ],
  shows: [
    row('r_tvcontinue', 'core.continue', { mediaType: 'tv' }),
    row('r_tvbecause', 'core.because', { mediaType: 'tv', count: 1 }),
    tv('r_tvpopular', { sort: 'popularity', minVotes: 200 }, 'Popular'),
    tv('r_tvnewseries', { sort: 'popularity', minVotes: 100, recentYears: 2 }, 'New series'),
    tv('r_tvtoprated', { sort: 'rating', minVotes: 1500 }, 'Top rated'),
    tv('r_tvdrama', { sort: 'popularity', minVotes: 100, genres: '18' }, 'Drama'),
    tv('r_tvcomedy', { sort: 'popularity', minVotes: 100, genres: '35' }, 'Comedy'),
    tv('r_tvcrime', { sort: 'popularity', minVotes: 100, genres: '80' }, 'Crime'),
    tv('r_tvscifi', { sort: 'popularity', minVotes: 100, genres: '10765' }, 'Sci-Fi & Fantasy'),
    tv('r_tvanimation', { sort: 'popularity', minVotes: 100, genres: '16' }, 'Animation'),
    tv('r_tvdocs', { sort: 'popularity', minVotes: 50, genres: '99' }, 'Documentaries')
  ]
};

/** A section's built-in layout, a fresh copy: { rows, known: [] } */
function layout(section) {
  return { rows: JSON.parse(JSON.stringify(LAYOUTS[section] || [])), known: [] };
}

module.exports = { layout: layout };
