export class Category {
  name ;
  query;

  constructor(name:string , query?:Object){

    this.name = name;
    this.query = query;

  }
}

let categories = [];

categories.push(new Category(
  "Trending",
  {
    url : "https://api.themoviedb.org/3/movie/popular?api_key=<<api_key>>&language=en-US&with_original_language=en&include_video=true",
    params : {}
  }
))

categories.push(new Category(
  "Animated movies" ,
  {
    url : "https://api.themoviedb.org/3/discover/movie?api_key=<<api_key>>&language=en-US&sort_by=popularity.desc&with_genres=16&with_original_language=en&include_video=true",
    params : {}

  }

))

categories.push(new Category(
  "Top rated" ,
  {
    url : "https://api.themoviedb.org/3/movie/top_rated?api_key=<<api_key>>&language=en-US&with_original_language=en&include_video=true",
    params : {}

  }

))






categories.push(new Category(
  "Comedy time" ,
  {
    url : "https://api.themoviedb.org/3/discover/movie?api_key=<<api_key>>&language=en-US&sort_by=popularity.desc&with_genres=35&with_original_language=en&include_video=true",
    params : {}


  }
))

categories.push(new Category(
  "Horror" ,
  {
    url : "https://api.themoviedb.org/3/discover/movie?api_key=<<api_key>>&language=en-US&sort_by=popularity.desc&with_genres=27&with_original_language=en&include_video=true",
    params : {}

  }
))

categories.push(new Category(
  "Action" ,
  {
    url : "https://api.themoviedb.org/3/discover/movie?api_key=<<api_key>>&language=en-US&sort_by=popularity.desc&with_genres=28&with_original_language=en&include_video=true",
    params : {}

  }
))

categories.push(new Category(
  "For family" ,
  {
    url : "https://api.themoviedb.org/3/discover/movie?api_key=<<api_key>>&language=en-US&sort_by=popularity.desc&with_genres=10751&with_original_language=en&include_video=true",
    params : {}

  }
))


categories.push(new Category(
  "Western movies" ,
  {
    url : "https://api.themoviedb.org/3/discover/movie?api_key=<<api_key>>&language=en-US&sort_by=popularity.desc&with_genres=37&with_original_language=en&include_video=true",
    params : {}

  }
))

// TV shows section rows. All use discover/tv: the trending/popular/top_rated
// endpoints ignore the language filter and are dominated by talk shows and
// soaps that rarely have torrents. News, reality and talk genres are excluded.
let showCategories = [];

const tvQuery = (extra: string) => ({
  url : "https://api.themoviedb.org/3/discover/tv?api_key=<<api_key>>&language=en-US" +
    "&with_original_language=en&without_genres=10763,10764,10767" + extra,
  params : {}
});

const twoYearsAgo = new Date(Date.now() - 2 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);

showCategories.push(new Category("Popular", tvQuery("&sort_by=popularity.desc&vote_count.gte=200")))
showCategories.push(new Category("New series", tvQuery(`&sort_by=popularity.desc&vote_count.gte=100&first_air_date.gte=${twoYearsAgo}`)))
showCategories.push(new Category("Top rated", tvQuery("&sort_by=vote_average.desc&vote_count.gte=1500")))
showCategories.push(new Category("Drama", tvQuery("&sort_by=popularity.desc&vote_count.gte=100&with_genres=18")))
showCategories.push(new Category("Comedy", tvQuery("&sort_by=popularity.desc&vote_count.gte=100&with_genres=35")))
showCategories.push(new Category("Crime", tvQuery("&sort_by=popularity.desc&vote_count.gte=100&with_genres=80")))
showCategories.push(new Category("Sci-Fi & Fantasy", tvQuery("&sort_by=popularity.desc&vote_count.gte=100&with_genres=10765")))
showCategories.push(new Category("Animation", tvQuery("&sort_by=popularity.desc&vote_count.gte=100&with_genres=16")))
showCategories.push(new Category("Documentaries", tvQuery("&sort_by=popularity.desc&vote_count.gte=50&with_genres=99")))

export {
  categories,
  showCategories
}

