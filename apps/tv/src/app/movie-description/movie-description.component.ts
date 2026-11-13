import { ProfilesService } from '../profiles.service';
import { NavigationService } from './../navigation.service';
import { BackgroundService } from './../background.service';
import { MoviesService, TitleItem, displayTitle } from './../movies.service';
import { Component, Input, OnInit, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs/operators';
import { MetaItem, TitleInfoModel, TitleMetaContext } from '../ui/public-api';
import { ContinueAt, episodeCode, timeLeft } from '../catalog';

// 1:05:12, 42:13
function clock(seconds:number):string {
  let s = Math.max(0, Math.floor(seconds)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
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
    // a plugin's card in a section's row: its own title info, as it is
    let given = (movie as Partial<TitleItem> & { info?:TitleInfoModel }).info;
    if (given) {
      this.info = given;
      this.slotContext = null;
      if (given.backdrop) this.backgroundService.sendImage(given.backdrop);
      return;
    }

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
      // TMDB's score only when IMDb has none
      if (movie.voteAverage && !movie.rating) meta.push({ kind: 'score', source: 'tmdb', value: movie.voteAverage });
    }
    return {
      title: displayTitle(movie),
      meta,
      genres: this.genres,
      overview: movie.overview || '',
      ...this.resumeLine((movie as Partial<TitleItem> & { continue?:ContinueAt }).continue, movie.mediaType == 'tv'),
    };
  }

  // A Continue watching card: where it is, with the amber line ("Resume S2 E5 “Name” · 20 min left")
  private resumeLine(at:ContinueAt | undefined, tv:boolean):{ status?:string, progress?:number | null } {
    if (!at) return {};
    let name = at.episodeName ? ` “${at.episodeName}”` : '';
    if (at.kind == 'next') {
      if (!tv) return { status: 'Watched' };
      let code = episodeCode(at.nextSeason ?? at.season, at.nextEpisode ?? at.episode + 1);
      return { status: `Up next: ${code}${name}` };
    }
    let left = timeLeft(at.positionS, at.durationS);
    return {
      status: tv ? `Resume ${episodeCode(at.season, at.episode)}${name} · ${left}` : `Resume from ${clock(at.positionS)} · ${left}`,
      progress: at.ratio,
    };
  }
}
