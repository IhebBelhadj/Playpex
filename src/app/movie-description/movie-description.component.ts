import { NavigationService } from './../navigation.service';
import { BackgroundService } from './../background.service';
import { MoviesService } from './../movies.service';
import { Component, Input, OnInit } from '@angular/core';

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

  ngOnInit(): void {
    this.moviesService.checkSelection().subscribe(movie=>{
      this.selectedMovie = movie;

      this.availableQualities = [];
      if (movie['torrents']) {

        movie['torrents'].forEach(torrent => {
          if(! this.availableQualities.includes(torrent['quality']))
            this.availableQualities.push(torrent['quality'])
        });
      }
      if (this.selectedMovie.release_date) {
        this.year = this.selectedMovie.release_date.slice(0,4)
      }
      this.onMovieSelect(movie);
    })

    this.navigation.onDescriptionUpdate().subscribe(movie => {
      this.selectedMovie = movie;
      console.log('updated description');

      this.availableQualities = [];
      if (movie['torrents']) {

        movie['torrents'].forEach(torrent => {
          if(! this.availableQualities.includes(torrent['quality']))
            this.availableQualities.push(torrent['quality'])
        });
      }
      if (this.selectedMovie.release_date) {
        this.year = this.selectedMovie.release_date.slice(0,4)
      }
      this.onMovieSelect(movie);
    })
  }

  constructor(
    private moviesService:MoviesService ,
    private backgroundService:BackgroundService,
    private navigation:NavigationService,
  ){}

  onMovieSelect(movie){
    this.backgroundService.sendImage(movie['backdrop_path'])
  }


}
