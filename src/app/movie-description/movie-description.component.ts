import { NavigationService } from './../navigation.service';
import { BackgroundService } from './../background.service';
import { MoviesService } from './../movies.service';
import { Component, Input, OnInit } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs/operators';

@Component({
  selector: 'movie-description',
  templateUrl: './movie-description.component.html',
  styleUrls: ['./movie-description.component.scss']
})
export class MovieDescriptionComponent implements OnInit {

  selectedMovie;
  movieDetails;
  availableQualities;
  year;
  fullDescription = false;
  shortDescription = "";
  genres = [];

  ngOnInit(): void {
    this.moviesService.checkSelection().subscribe(movie=>{

      if(!movie) return;
      if (Object.keys(movie).length == 0) return;

      this.dataUpdate(movie);

    })

    this.navigation.onDescriptionUpdate().subscribe(movie => {
      this.dataUpdate(movie);
    })

    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map(e => {

        if (e.url.includes('/movies/movie')) {

          this.fullDescription = true;
        }
        else {
          this.fullDescription = false;
        }

      })
    ).subscribe()
  }

  constructor(
    private moviesService:MoviesService ,
    private backgroundService:BackgroundService,
    private navigation:NavigationService,
    private router:Router,
  ){}

  onMovieSelect(movie){
    this.backgroundService.sendImage(movie['backdrop_path'])
  }

  dataUpdate(movie){
    this.selectedMovie = movie;

    this.shortDescription = this.selectedMovie.overview.slice(0 , 255);
    this.availableQualities = [];
    if (movie['torrents']) {

      movie['torrents'].forEach(torrent => {
        if(! this.availableQualities.includes(torrent['quality']))
          this.availableQualities.push(torrent['quality'])
      });
    }

    this.genres = [];
    if (movie['genres']) {
      movie['genres'].forEach(el => {
        this.genres.push(el['name'])
      });
    }

    if (this.selectedMovie.release_date) {
      this.year = this.selectedMovie.release_date.slice(0,4)
    }
    this.onMovieSelect(movie);
  }


}
