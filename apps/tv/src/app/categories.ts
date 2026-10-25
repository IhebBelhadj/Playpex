// A row of a section: its name and the server's catalog query that fills it
// (`path` under /catalog/, e.g. 'lists/movie/popular' or 'discover/tv'; its
// `params`, `page` set while paging)
export interface CatalogQuery {
  path: string;
  params: { [param: string]: string | number };
}

export class Category {
  name: string;
  query: CatalogQuery;

  constructor(name:string , query:CatalogQuery){

    this.name = name;
    this.query = query;

  }
}

// Movies section rows; array order = display order
let categories:Category[] = [];

const movieGenre = (genre: string) => ({
  path: 'discover/movie',
  params: { sort: 'popularity', genres: genre, language: 'en' } as { [param: string]: string | number },
});

categories.push(new Category("Trending", { path: 'lists/movie/popular', params: {} }))
categories.push(new Category("Animated movies", movieGenre('16')))
categories.push(new Category("Top rated", { path: 'lists/movie/top_rated', params: {} }))
categories.push(new Category("Comedy time", movieGenre('35')))
categories.push(new Category("Horror", movieGenre('27')))
categories.push(new Category("Action", movieGenre('28')))
categories.push(new Category("For family", movieGenre('10751')))
categories.push(new Category("Western movies", movieGenre('37')))

// TV shows section rows. All use discover: the trending/popular/top_rated
// lists ignore the language filter and are dominated by talk shows and
// soaps that rarely have torrents. News, reality and talk genres are excluded.
let showCategories:Category[] = [];

const tvQuery = (extra: { [param: string]: string | number }) => ({
  path: 'discover/tv',
  params: { language: 'en', withoutGenres: '10763,10764,10767', ...extra },
});

const twoYearsAgo = new Date(Date.now() - 2 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);

showCategories.push(new Category("Popular", tvQuery({ sort: 'popularity', minVotes: 200 })))
showCategories.push(new Category("New series", tvQuery({ sort: 'popularity', minVotes: 100, from: twoYearsAgo })))
showCategories.push(new Category("Top rated", tvQuery({ sort: 'rating', minVotes: 1500 })))
showCategories.push(new Category("Drama", tvQuery({ sort: 'popularity', minVotes: 100, genres: '18' })))
showCategories.push(new Category("Comedy", tvQuery({ sort: 'popularity', minVotes: 100, genres: '35' })))
showCategories.push(new Category("Crime", tvQuery({ sort: 'popularity', minVotes: 100, genres: '80' })))
showCategories.push(new Category("Sci-Fi & Fantasy", tvQuery({ sort: 'popularity', minVotes: 100, genres: '10765' })))
showCategories.push(new Category("Animation", tvQuery({ sort: 'popularity', minVotes: 100, genres: '16' })))
showCategories.push(new Category("Documentaries", tvQuery({ sort: 'popularity', minVotes: 50, genres: '99' })))

export {
  categories,
  showCategories
}
