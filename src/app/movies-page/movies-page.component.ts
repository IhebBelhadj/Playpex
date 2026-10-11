import { SplashService } from './../splash.service';
import { NavigationService } from './../navigation.service';
import { MoviesService } from './../movies.service';
import { Component, OnInit, OnDestroy } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { switchMap, Subscription, map, Observable } from 'rxjs';
import { Catalog } from '../catalog';

// Home page of a section (movies or TV shows, from route data `media`):
// loads the category rows into the section's Catalog and enriches the
// focused item for <movie-description>.
@Component({
  selector: 'movies-page',
  templateUrl: './movies-page.component.html',
  styleUrls: ['./movies-page.component.scss']
})
export class MoviesPageComponent implements OnInit , OnDestroy {

  catalog:Catalog;
  selectedMovie;
  selectedMovieSub:Subscription;
  pageRequestSub:Subscription;

  constructor(
    private moviesService:MoviesService,
    private navigation:NavigationService,
    private splashService:SplashService,
    private route:ActivatedRoute,
  ) { }

  ngOnInit(): void {
    this.catalog = this.moviesService.catalogs[this.route.snapshot.data['media'] || 'movie'];

    // Coming from the other section: don't describe its last item here
    let selected = this.moviesService.selectedmovie.value;
    if ((selected['media_type'] == 'tv') !== (this.catalog.media == 'tv')) {
      this.moviesService.assignSelection({});
    }

    if (Object.keys(this.catalog.items.value).length === 0) {

      // Rows keep category order whatever order the requests finish in
      let items = {};
      this.catalog.categories.forEach(c => items[c.name] = []);
      this.catalog.items.next(items);

      this.catalog.categories.forEach(c => {
        this.getMovies(c.name , c.query);
        this.catalog.reachedPages[c.name] = 1;

        // initialize slider navigation data
        this.catalog.navigationData[c.name] = {
          reached : '0',
          selected : false
        }
      })

      this.splashService.splashExecuteCommand().subscribe(instruction=>{
        if (instruction == "clearSplash") {
          setTimeout(()=>{
            this.navigation.sendMovieSliderEvent('focusFirst');
          },300)
        }
      })
    }

    this.subscribeToSelections();

    // Slider reached the end of a row: append the next TMDB page
    this.pageRequestSub = this.catalog.onPageRequest().subscribe(request => {
      let query = this.catalog.findCategory(request.category).query;
      query['params']['page'] = request.page;

      if (request.page > this.catalog.reachedPages[request.category]) {
        this.catalog.reachedPages[request.category] += 1;
        this.getMovies(request.category , query);
      }
    })
  }

  ngOnDestroy(): void {
    this.selectedMovieSub.unsubscribe();
    this.pageRequestSub.unsubscribe();
  }

  subscribeToSelections(){
    this.selectedMovieSub = this.catalog.onSelect()
    .pipe(
      switchMap(data => {
        let item = this.catalog.items.value[data.category]?.[Number(data.index)];
        if (item) {
          if (this.catalog.media == 'tv') item.media_type = 'tv';
          this.selectedMovie = item;
          this.moviesService.assignSelection(this.selectedMovie);
        }
        return this.catalog.media == 'tv' ? this.enrichShow(data.id) : this.enrichMovie(data.id);
      }))
      .subscribe(() => {
        this.moviesService.assignSelection(this.selectedMovie);
      } , error => {
        console.log(error);
        this.subscribeToSelections();
      })
  }

  // TMDB genres + YTS torrents/rating/runtime/trailer
  enrichMovie(id):Observable<any> {
    return this.moviesService.getTmdbMovieDetails(id).pipe(
      map(data => {
        this.selectedMovie.genres = data['genres'];
        this.moviesService.assignSelection(this.selectedMovie);
        return data;
      }),
      switchMap(tmdbData => this.moviesService.getYTSMovieDetails(tmdbData['imdb_id']).pipe(
        map(ytsData => {
          this.selectedMovie['torrents'] = ytsData['data']['movie']['torrents']
          this.selectedMovie['mpa_rating'] = ytsData['data']['movie']['mpa_rating']
          this.selectedMovie['rating'] = ytsData['data']['movie']['rating']
          this.selectedMovie['runtime'] = ytsData['data']['movie']['runtime']
          this.selectedMovie['trailer'] = ytsData['data']['movie']['yt_trailer_code']
          this.selectedMovie.imdb_id = tmdbData['imdb_id'];
        })
      ))
    )
  }

  // TMDB genres, season count and score (episodes are loaded on the show page)
  enrichShow(id):Observable<any> {
    return this.moviesService.getTvDetails(id).pipe(
      map(data => {
        this.selectedMovie.genres = data['genres'];
        this.selectedMovie.number_of_seasons = data['number_of_seasons'];
        this.selectedMovie.imdb_id = data['external_ids']?.['imdb_id'];
      })
    )
  }

  getMovies(category:string , query){
    this.moviesService.getMovies(query).subscribe(res => {
      // append the new page to the row (or start it)
      let items = this.catalog.items.value;
      items[category] = (items[category] || []).concat(res['results']);
      this.catalog.items.next(items);
    })
  }

}
