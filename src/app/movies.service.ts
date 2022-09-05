import { Injectable } from '@angular/core';
import {HttpClient} from '@angular/common/http'
import { BehaviorSubject, Observable, Subject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})

export class MoviesService {


  //Description of thes observable subjects is in the
  //method definitions below

  private subject = new Subject<any>();
  private selector = new Subject();

  selectedmovie = new BehaviorSubject({});
  movies = new BehaviorSubject({});
  movieAppHistory = [];

  navigationData = {};

  private tmdb_key = "0067d3f9de200e949bc7f144b1ff83f1";



  constructor(private http:HttpClient) { }


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
    return this.http.get(`https://api.themoviedb.org/3/movie/${tmdb_id}?api_key=${this.tmdb_key}&language=en-US`)
  }

  searchMovies(query:string){
    return this.http.get(`https://api.themoviedb.org/3/search/movie?api_key=${this.tmdb_key}&language=en-US&query=${query}&include_adult=false`)
  }

  getYTSMovieDetails(id){
    return this.http.get(`http://localhost:9000/api/movies/${id}`)
  }


  // ****Observers for sharing data between components****



  // keeping track of movies object which contains categories
  //with arrays of movies
      assignMovies(movies){
        this.movies.next(movies);
      }

      checkMovies():Observable<any>{
        return this.movies.asObservable();
      }


  // keeps track of movies object update requests like
  // append new movies page when navigating through slider, etc ....
      requestMovies(params) {
        this.subject.next(params);
      }

      requestListener(): Observable<any> {
        return this.subject.asObservable();
      }

  // keeps track of currently selected movie in movie slider
      selectMovie(e){
        this.selector.next(e);
      }

      selectedMovie(): Observable<any> {
        return this.selector.asObservable();
      }


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
            //this.movieAppHistory = this.movieAppHistory.filter(movie=>{movie['id'] != id})
            break;
          }

        }

        return element;
      }





}
