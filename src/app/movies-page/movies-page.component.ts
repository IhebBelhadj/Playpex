import { MoviesSliderComponent } from './../movies-slider/movies-slider.component';

import { MoviesService } from './../movies.service';
import { Component, OnInit, ViewChild } from '@angular/core';
import {Category , categories} from '../categories'

@Component({
  selector: 'movies-page',
  templateUrl: './movies-page.component.html',
  styleUrls: ['./movies-page.component.scss']
})
export class MoviesPageComponent implements OnInit {

  selectedMovie;
  _categories:Array<Category> = categories;
  movies = {};
  reachedPages = {};

  @ViewChild(MoviesSliderComponent) moviesSlider:MoviesSliderComponent;
  constructor(private moviesService:MoviesService) { }



  ngOnInit(): void {

    if ( Object.keys(this.moviesService.movies.value).length !== 0) {
      this.movies = this.moviesService.movies.value;
    }
    else {

      this._categories.forEach(c => {
        //Get movies for each category
        this.getMovies(c.name , c.query);
        this.reachedPages[c.name] = 1;

        // initialize movie slider navigation data
        this.moviesService.navigationData[c.name] = {
          reached : '0',
          selected : false
        }

      })
    }


    this.moviesService.selectedMovie().subscribe((data)=>{

      if (this.movies[data.category][Number(data.index)]) {
        this.selectedMovie = this.movies[data.category][Number(data.index)];
        this.moviesService.getTmdbMovieDetails(data.id).subscribe(tmdb_data =>{
          let genres = [];
          tmdb_data['genres'].forEach(el => {
            genres.push(el['name'])
          });

          this.selectedMovie.genres = genres;
          this.selectedMovie.imdb_id = tmdb_data['imdb_id'];
          this.moviesService.assignSelection(this.selectedMovie);

        })

      }

    })

    // On movie object update request(appending new movies , etc ...)
    this.moviesService.requestListener().subscribe(request => {

      //from categories array find the matching query (url + params)
      let query = this.findCategoryQuery(request['category'])
      query['params']['page'] = request['page']

      if (query['params']['page'] > this.reachedPages[request['category']]) {
        this.reachedPages[request['category']] += 1;
        this.getMovies(request['category'] , query);
      }

    })

  }

  //Main method for getting movies from service
  getMovies(category:string , query){

     this.moviesService.getMovies(query).subscribe(res => {

      let tempMovies = res;
      // if there are already movies append to the available array
      //otherwise start from an empty array
      let current = this.movies[category] || [];
      this.movies[category]  =  current.concat(tempMovies['results']);

      // save the changed movies object to the movies service
      this.moviesService.assignMovies(this.movies);

    })
  }


  // Fetch the categories array to get category query
  findCategoryQuery(name){

    let query;
    this._categories.forEach(element => {

      if (element.name === name) {
        query = element.query
      }
    });

    return query;
  }

}




