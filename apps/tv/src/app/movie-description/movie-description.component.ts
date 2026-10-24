import { ProfilesService } from '../profiles.service';
import { NavigationService } from './../navigation.service';
import { BackgroundService } from './../background.service';
import { MoviesService } from './../movies.service';
import { Component, Input, OnInit, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs/operators';
import { MetaItem, TitleInfoModel, TitleMetaContext } from '../ui/public-api';
import { profileContext } from '../slot-contexts';

// The focused / opened title's info block (<px-title-info>): a movie's year,
// IMDb; a show's year, seasons, TMDB score; genres and overview. Plugins and
// the server add to its meta line (slot core.title.meta: "On this server", …).
// Pushes the backdrop to BackgroundService.
@Component({
  selector: 'movie-description',
  templateUrl: './movie-description.component.html',
  styleUrls: ['./movie-description.component.scss']
})
export class MovieDescriptionComponent implements OnInit {

  private profiles = inject(ProfilesService);

  selectedMovie;
  movieDetails;
  year;
  fullDescription = false;
  shortDescription = "";
  genres = [];
  info:TitleInfoModel | null = null;
  // what plugins' meta items get (ui/slots)
  slotContext:TitleMetaContext | null = null;

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

        if (e.url.includes('/movies/movie') || e.url.includes('/shows/show')) {

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

    this.shortDescription = (this.selectedMovie.overview || '').slice(0 , 255);
    this.genres = [];
    if (movie['genres']) {
      movie['genres'].forEach(el => {
        this.genres.push(el['name'])
      });
    }

    // movies have release_date, TV shows first_air_date
    let date = this.selectedMovie.release_date || this.selectedMovie.first_air_date;
    this.year = date ? date.slice(0,4) : undefined;
    this.info = this.titleInfo(movie);
    this.slotContext = movie?.id ? {
      kind: movie.media_type == 'tv' ? 'tv' : 'movie', tmdbId: Number(movie.id),
      imdbId: movie.imdb_id || movie.external_ids?.imdb_id || null, profile: profileContext(this.profiles.current.value),
    } : null;
    this.onMovieSelect(movie);
  }

  private titleInfo(movie):TitleInfoModel {
    let meta:MetaItem[] = [];
    if (this.year) meta.push({ kind: 'text', text: this.year });
    if (movie.rating) meta.push({ kind: 'score', source: 'imdb', value: movie.rating });
    if (movie.media_type == 'tv') {
      let seasons = movie.number_of_seasons;
      if (seasons) meta.push({ kind: 'chip', text: `${seasons} ${seasons == 1 ? 'season' : 'seasons'}` });
      if (movie.vote_average) meta.push({ kind: 'score', source: 'tmdb', value: movie.vote_average });
    }
    return {
      title: movie.original_title || movie.name || '',
      meta,
      genres: this.genres,
      overview: movie.overview || '',
    };
  }
}
