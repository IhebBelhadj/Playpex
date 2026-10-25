import { ProfilesService } from '../profiles.service';
import { NavigationService } from './../navigation.service';
import { BackgroundService } from './../background.service';
import { MoviesService, TitleItem, displayTitle } from './../movies.service';
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

  selectedMovie:Partial<TitleItem>;
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

  onMovieSelect(movie:Partial<TitleItem>){
    this.backgroundService.sendImage(movie.backdropPath)
  }

  dataUpdate(movie:Partial<TitleItem>){
    this.selectedMovie = movie;

    this.shortDescription = (this.selectedMovie.overview || '').slice(0 , 255);
    this.genres = (movie.genres || []).map(g => g.name);

    this.year = movie.year || undefined;
    this.info = this.titleInfo(movie);
    this.slotContext = movie?.tmdbId ? {
      kind: movie.mediaType == 'tv' ? 'tv' : 'movie', tmdbId: Number(movie.tmdbId),
      imdbId: movie.imdbId || null, profile: profileContext(this.profiles.current.value),
    } : null;
    this.onMovieSelect(movie);
  }

  private titleInfo(movie:Partial<TitleItem>):TitleInfoModel {
    let meta:MetaItem[] = [];
    if (this.year) meta.push({ kind: 'text', text: this.year });
    if (movie.rating) meta.push({ kind: 'score', source: 'imdb', value: movie.rating });
    if (movie.mediaType == 'tv') {
      let seasons = movie.seasonCount;
      if (seasons) meta.push({ kind: 'chip', text: `${seasons} ${seasons == 1 ? 'season' : 'seasons'}` });
      if (movie.voteAverage) meta.push({ kind: 'score', source: 'tmdb', value: movie.voteAverage });
    }
    return {
      title: displayTitle(movie),
      meta,
      genres: this.genres,
      overview: movie.overview || '',
    };
  }
}
