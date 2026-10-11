import { YoutubeService } from './youtube.service';
import { Injectable } from '@angular/core';
import {HttpClient} from '@angular/common/http'
import { BehaviorSubject, Observable } from 'rxjs';
import { Catalog, MediaType } from './catalog';
import { categories, showCategories } from './categories';
import { STREAMING_SERVER } from './server-config';

@Injectable({
  providedIn: 'root'
})

export class MoviesService {


  //Description of thes observable subjects is in the
  //method definitions below

  // Browsable sections; the home page/slider pick one via route data `media`
  catalogs: { [media in MediaType]: Catalog } = {
    movie: new Catalog('movie', categories, '/movies/list', '/movies/movie'),
    tv: new Catalog('tv', showCategories, '/shows/list', '/shows/show'),
  };

  // Item shown in <movie-description>: a TMDB movie, or a TV show (media_type 'tv')
  selectedmovie = new BehaviorSubject({});
  searchData = new BehaviorSubject({
    query:"",
    results:{},
    lastFocused:undefined ,
    sectionScroll : 0
  });
  movieAppHistory = [];

  private tmdb_key = "0067d3f9de200e949bc7f144b1ff83f1";



  constructor(
    private http:HttpClient,
    ) { }


  //****Tmdb API endpoints setup****

  getMovies(query){
    let params = query.params;

    let url = query.url as string;
    url = url.replace('<<api_key>>' , this.tmdb_key)
    return this.http.get(url , {params : params})
  }


  getCredits(id){
    return this.http.get(`https://api.themoviedb.org/3/movie/${id}/credits?api_key=${this.tmdb_key}&language=en-US`)
  }

  getSimilarMovies(id){
    return this.http.get(`https://api.themoviedb.org/3/movie/${id}/similar?api_key=${this.tmdb_key}&language=en-US&page=1&with_original_language=en`)
  }


  getTmdbMovieDetails(tmdb_id){
    return this.http.get(`https://api.themoviedb.org/3/movie/${tmdb_id}?api_key=${this.tmdb_key}&language=en-US` , {
      headers : {
        "Cache-Control": "no-store"
      }
    })
  }

  searchMovies(query:string){
    return this.http.get(`https://api.themoviedb.org/3/search/movie?api_key=${this.tmdb_key}&language=en-US&query=${query}&include_adult=false`)
  }

  getYTSMovieDetails(id){
    return this.http.get(`${STREAMING_SERVER}/api/movies/${id}`)
  }

  // TV: details incl. imdb id (for torrents/subtitles) and trailers
  getTvDetails(tmdb_id){
    return this.http.get(`https://api.themoviedb.org/3/tv/${tmdb_id}?api_key=${this.tmdb_key}&language=en-US&append_to_response=external_ids,videos`)
  }

  getTvSeason(tmdb_id, season_number){
    return this.http.get(`https://api.themoviedb.org/3/tv/${tmdb_id}/season/${season_number}?api_key=${this.tmdb_key}&language=en-US`)
  }

  catalogForUrl(url:string):Catalog {
    return Object.values(this.catalogs).find(c => c.listUrl === url);
  }

  getMovieVideos(tmdb_id){
    return this.http.get(`https://api.themoviedb.org/3/movie/${tmdb_id}/videos?api_key=${this.tmdb_key}&language=en-US`)
  }



  // ****RXJS Subjects for sharing data between components****



  //Keeps track of the object movie that is going to be
  //sent to the movie description and later display its properties in the view
      assignSelection(movie){
        this.selectedmovie.next(movie);
      }

      checkSelection():Observable<any>{
        return this.selectedmovie.asObservable();
      }

  //keeps track of the movies you opened (from slider or similar movies or from search page)
  //and creates a stack to not get the data each time

      addMovieToHistory(movie){
        let canAdd = true;
        this.movieAppHistory.forEach(el => {
          if (movie['id'] == el['id']) {
            canAdd = false;
          }
        });

        if (canAdd) this.movieAppHistory.push(movie);

      }

      getAppMovieHistory():Array<Object>{
        return this.movieAppHistory;
      }

      popFromHistoryStack(id){
        this.movieAppHistory = this.movieAppHistory.filter(movie => movie.id != id)
      }

      getMovieFromStack(id){
        console.log(this.movieAppHistory);

        var element = undefined;
        for (let i = 0; i < this.movieAppHistory.length; i++) {

          if (this.movieAppHistory[i]['id'] == id) {
            element = this.movieAppHistory[i];
            break;
          }

        }

        return element;
      }

// Keeps track of the search page results

  updateSearchData(
    query ,
    results ,
    focusData = {
      index : undefined ,
      sectionScroll : 0
    }){
    this.searchData.next({
      query:query,
      results:results,
      lastFocused:focusData.index ,
      sectionScroll : focusData.sectionScroll
    });
    console.log(this.searchData.value);

  }

  deleteSearchData(){
    this.searchData.next({
      query:"",
      results:{},
      lastFocused:undefined ,
      sectionScroll : 0
    });
  }






}
