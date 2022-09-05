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

export {
  categories
}

