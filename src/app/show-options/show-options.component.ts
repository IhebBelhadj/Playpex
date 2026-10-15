import { Location } from '@angular/common';
import { Component, AfterViewInit, OnDestroy } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { defaultIfEmpty, distinctUntilChanged, Observable, Subject, Subscription, switchMap, map } from 'rxjs';
import { gsap, Power1 } from 'gsap'
import { MenuServiceService } from '../menu-service.service';
import { MoviesService } from '../movies.service';
import { NavigationService } from '../navigation.service';
import { NotificationService } from '../notification.service';
import { PlaybackService } from '../playback.service';
import { TorrentService } from '../torrent.service';
import { TorrentPickerService } from '../torrent-picker.service';
import { EpisodeProgress, LibraryService } from '../library.service';
import { PlayChoiceService } from '../play-choice.service';
import { isPointerFocus } from '../pointer.service';

// TV show page (/shows/show/:id): Play / Trailer, a seasons row and the
// selected season's episodes. Enter on an episode finds its torrents
// (EZTV + TheRARBG via the local server), lets the user pick one and starts the player.
@Component({
  selector: 'app-show-options',
  templateUrl: './show-options.component.html',
  styleUrls: ['./show-options.component.scss']
})
export class ShowOptionsComponent implements AfterViewInit , OnDestroy {

  stillBase = "https://image.tmdb.org/t/p/w300";

  show;
  imdbId:string;
  trailer:string;
  seasons = [];
  selectedSeason:number;
  seasonName = "";
  episodes = [];
  loadingEpisodes = false;
  resolvingEpisode:number;           // episode_number whose torrents are being looked up

  // The current profile's state for this show
  inWatchlist = false;
  private episodeProgress = new Map<string, EpisodeProgress>();
  private libraryBusy = false;

  private seasonRequests = new Subject<{ showId:number , season:number }>();
  private subscriptions:Subscription[] = [];
  private focusListener;
  private today = new Date().toISOString().slice(0, 10);

  constructor(
    private route:ActivatedRoute,
    private router:Router,
    private location:Location,
    private moviesService:MoviesService,
    private navigation:NavigationService,
    private menu:MenuServiceService,
    private notificationService:NotificationService,
    private torrentService:TorrentService,
    private playback:PlaybackService,
    private torrentPicker:TorrentPickerService,
    private library:LibraryService,
    private playChoice:PlayChoiceService,
  ) { }

  ngAfterViewInit(): void {
    this.menu.sendInstruction('collapse' , this);

    this.navigation.updateNavigation('add' , {
      id: 'showOptions',
      selector: '.showOptionsContainer .focusable',
      restrict : "self-only",
      leaveFor: {
        left: '@menu',
      },
      enterTo: 'last-focused',
      straightOnly: true,
    })
    this.navigation.updateNavigation('add',{
      id: 'menu',
      selector: '.menuContainer .element',
      restrict : "self-only",
      leaveFor: {
        right: '@showOptions'
      }
    })
    this.navigation.updateNavigation('focus' , {sectionId : 'showOptions'})

    this.subscriptions.push(
      this.route.params.subscribe(params => this.loadShow(params['id'])),

      // Latest focused season wins; earlier requests are cancelled
      this.seasonRequests.pipe(
        distinctUntilChanged((a, b) => a.showId === b.showId && a.season === b.season),
        switchMap(request => {
          this.loadingEpisodes = true;
          return this.moviesService.getTvSeason(request.showId , request.season).pipe(map(data => ({ request, data })));
        })
      ).subscribe(({ request, data }) => {
        this.loadingEpisodes = false;
        this.selectedSeason = request.season;
        this.seasonName = data['name'];
        this.episodes = (data['episodes'] || []).map(ep => ({
          ...ep,
          upcoming: !ep.air_date || ep.air_date > this.today
        }));
        setTimeout(() => this.resetEpisodesRow(), 0);
      } , () => {
        this.loadingEpisodes = false;
        this.notificationService.sendNotification("error" , "Couldn't load this season's episodes");
      }),

      this.navigation.executeCommand().subscribe(instruction => this.onCommand(instruction)),
    );

    this.focusListener = (e) => this.onFocus(e.target as HTMLElement);
    window.addEventListener('sn:focused', this.focusListener);
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach(s => s.unsubscribe());
    window.removeEventListener('sn:focused', this.focusListener);
    this.navigation.updateNavigation('remove' , {sectionId : 'menu'});
    this.navigation.updateNavigation('remove' , {sectionId : 'showOptions'});
    let pageContainer = document.querySelector('.pageContainer') as HTMLElement;
    if (pageContainer) pageContainer.style.transform = `translateY(0px)`;
  }

  loadShow(id){
    this.moviesService.getTvDetails(id).subscribe(show => {
      this.show = show;
      this.imdbId = show['external_ids']?.['imdb_id'];
      this.trailer = this.pickTrailer(show['videos']?.['results'] || []);

      // Regular seasons first, "Specials" (season 0) last
      this.seasons = (show['seasons'] || [])
        .filter(s => s.episode_count > 0)
        .sort((a, b) => (a.season_number || 1000) - (b.season_number || 1000));

      // Describe the show above the page
      this.moviesService.assignSelection({ ...show, media_type : 'tv' });
      this.loadLibraryState();

      if (this.seasons.length) {
        this.seasonRequests.next({ showId : show['id'] , season : this.seasons[0].season_number });
      }

      setTimeout(() => {
        this.markDefault('.seasons');
        (document.querySelector('.showOptionsContainer .play') as HTMLElement)?.focus({preventScroll : true});
      }, 0);
    } , () => {
      this.notificationService.sendNotification("error" , "Couldn't load this show");
    })
  }

  // 18+ show (TMDB `adult`): never enters the profile's library
  get isAdult():boolean {
    return !!this.show?.['adult'];
  }

  loadLibraryState(){
    this.inWatchlist = false;
    this.episodeProgress.clear();
    if (this.isAdult) return;
    let ref = { mediaType : 'tv' as const , tmdbId : Number(this.show['id']) };
    this.library.inWatchlist(ref).subscribe({ next : r => this.inWatchlist = r.inWatchlist , error : () => {} });
    this.library.episodesProgress(ref).subscribe({
      next : list => list.forEach(p => this.episodeProgress.set(`${p.season}x${p.episode}` , p)),
      error : () => {},
    });
  }

  // Shown on the episode thumbnail: a watched badge, or a bar once it's started
  progressOf(ep):EpisodeProgress | null {
    let progress = this.episodeProgress.get(`${this.selectedSeason}x${ep.episode_number}`);
    return progress && (progress.finished || progress.ratio >= 0.02) ? progress : null;
  }

  toggleWatchlist(){
    if (this.libraryBusy || !this.show) return;
    this.libraryBusy = true;
    let ref = { mediaType : 'tv' as const , tmdbId : Number(this.show['id']) };
    let adding = !this.inWatchlist;
    this.inWatchlist = adding;
    let request:Observable<unknown> = adding
      ? this.library.addToWatchlist(ref , LibraryService.artworkOf(this.show))
      : this.library.removeFromWatchlist(ref);
    request.subscribe({
      next : () => this.libraryBusy = false,
      error : () => {
        this.libraryBusy = false;
        this.inWatchlist = !adding;
        this.notificationService.sendNotification("error" , "Couldn't update your watch list. Is the Playpex server running?");
      }
    });
  }

  pickTrailer(videos){
    let youtube = videos.filter(v => v.site == 'YouTube');
    let trailer = youtube.find(v => v.type == 'Trailer') || youtube[0];
    return trailer?.key;
  }

  onCommand(instruction){
    if (!this.router.url.includes('/shows/show')) return;
    let active = document.activeElement as HTMLElement;

    if (instruction == 'back') {
      this.location.back();
      return;
    }
    if (instruction != 'click') return;

    switch (true) {
      case active.classList.contains('play'):
        let next = this.episodes.find(ep => !ep.upcoming);
        if (next) this.playEpisode(next);
        else this.notificationService.sendNotification("error" , "No aired episodes in this season yet");
        break;
      case active.classList.contains('addWatchlist'):
        this.toggleWatchlist();
        break;
      case active.classList.contains('trailer'):
        if (this.trailer) this.showYtVid(this.trailer);
        else this.notificationService.sendNotification("error" , "No trailer found");
        break;
      case active.classList.contains('season'):
        (document.querySelector('.episodes .lastSelected') as HTMLElement)?.focus({preventScroll : true});
        break;
      case active.classList.contains('episodeBtn'):
        this.playEpisode(this.episodes[Number(active.dataset['index'])]);
        break;
      default:
        break;
    }
  }

  // With a saved position, ask Resume / Play from the beginning first
  playEpisode(ep){
    if (!ep || this.resolvingEpisode !== undefined) return;
    let code = this.episodeCode(this.selectedSeason , ep.episode_number);

    if (ep.upcoming) {
      this.notificationService.sendNotification("error" , `${code} hasn't aired yet`);
      return;
    }

    let season = this.selectedSeason;
    let key = { mediaType : 'tv' as const , tmdbId : Number(this.show['id']) , season , episode : ep.episode_number };
    this.resolvingEpisode = ep.episode_number;
    // no current profile: state() completes empty → play as usual
    this.library.state(key).pipe(defaultIfEmpty({ resume : null , finished : false })).subscribe({
      next : state => {
        this.resolvingEpisode = undefined;
        let resume = state.resume;
        if (!resume) {
          this.findAndPlay(ep , code);
          return;
        }
        this.playChoice.choose(`${this.show['name']} ${code}` , resume).subscribe(choice => {
          if (choice == 'restart') this.findAndPlay(ep , code , 0);
          // same release as last time, so the saved position matches
          else if (resume.infoHash) this.playChosen(ep , code , { magnet : resume.infoHash } , resume.positionS , season);
          else this.findAndPlay(ep , code , resume.positionS);
        });
      },
      // no saved state (or no server): play as usual
      error : () => {
        this.resolvingEpisode = undefined;
        this.findAndPlay(ep , code);
      },
    });
  }

  findAndPlay(ep , code:string , startAt?:number){
    if (!this.imdbId) {
      this.notificationService.sendNotification("error" , "This show has no IMDb id, so torrents can't be looked up");
      return;
    }

    let season = this.selectedSeason;
    this.resolvingEpisode = ep.episode_number;
    this.torrentService.findEpisodeTorrents(this.imdbId , this.show['name'] , season , ep.episode_number)
      .subscribe(result => {
        this.resolvingEpisode = undefined;
        if (!result.torrents.length) {
          let reason = result.providerErrors ? " (some providers are unreachable)" : "";
          this.notificationService.sendNotification("error" , `No torrents found for ${code}${reason}`);
          return;
        }

        let options = result.torrents.map((torrent, i) => TorrentPickerService.fromEpisode(torrent , i));
        this.torrentPicker.choose(`${this.show['name']} ${code}` , options)
          .subscribe(choice => this.playChosen(ep , code , choice.torrent , startAt , season));
      } , () => {
        this.resolvingEpisode = undefined;
        this.notificationService.sendNotification("error" , "Couldn't reach the torrent providers. Try again later");
      })
  }

  // season: the one the episode belongs to (the user may have focused another meanwhile)
  playChosen(ep , code:string , torrent , startAt?:number , season = this.selectedSeason){
    this.playback.play({
      title : this.show['name'],
      subtitle : `${code} · ${ep.name}`,
      year : (ep.air_date || '').slice(0, 4),
      runtimeMinutes : ep.runtime,
      magnet : torrent.magnet,
      imdbId : this.imdbId,
      season : season,
      episode : ep.episode_number,
      mediaType : 'tv',
      tmdbId : this.show['id'],
      artwork : LibraryService.artworkOf(this.show),
      startAt,
      adult : this.isAdult,
    });
    this.router.navigateByUrl('/player');
  }

  episodeCode(season , episode){
    let pad = n => (n < 10 ? '0' : '') + n;
    return `S${pad(season)}E${pad(episode)}`;
  }

  // Spatial navigation focus: remember position per row, scroll rows into view
  // (not for mouse hovers: the row would slide away under the cursor)
  onFocus(node:HTMLElement){
    if (!this.router.url.includes('/shows/show') || !node.closest('.showOptionsContainer')) return;
    let scroll = !isPointerFocus();

    if (node.closest('.optionPannel')) {
      this.updateLastSelected('.optionPannel' , node);
      this.setPageOffset(0);
    }
    else if (node.classList.contains('season')) {
      this.updateLastSelected('.seasons' , node);
      if (scroll) {
        this.scrollRowTo(node);
        this.ensureRowVisible('.seasons');
      }
      this.seasonRequests.next({ showId : this.show['id'] , season : Number(node.dataset['season']) });
    }
    else if (node.classList.contains('episodeBtn')) {
      this.updateLastSelected('.episodes' , node);
      if (scroll) {
        this.scrollRowTo(node);
        this.ensureRowVisible('.episodes');
      }
    }
  }

  updateLastSelected(rowSelector:string , node:HTMLElement){
    document.querySelectorAll(`.showOptionsContainer ${rowSelector} .focusable`).forEach(el => el.classList.remove('lastSelected'));
    node.classList.add('lastSelected');
  }

  markDefault(rowSelector:string){
    let row = document.querySelector(`.showOptionsContainer ${rowSelector}`);
    if (row && !row.querySelector('.lastSelected')) {
      row.querySelector('.focusable')?.classList.add('lastSelected');
    }
  }

  resetEpisodesRow(){
    let content = document.querySelector('.showOptionsContainer .episodes .content') as HTMLElement;
    if (content) content.style.transform = `translateX(0px)`;
    document.querySelectorAll('.showOptionsContainer .episodes .lastSelected').forEach(el => el.classList.remove('lastSelected'));
    this.markDefault('.episodes');
  }

  // Horizontal: keep the focused item about a third into the row
  scrollRowTo(node:HTMLElement){
    let content = node.closest('.content') as HTMLElement;
    let viewport = content.parentElement;
    let max = Math.max(0 , content.scrollWidth - viewport.clientWidth);
    let target = Math.min(max , Math.max(0 , node.offsetLeft - viewport.clientWidth / 3));
    content.style.transform = `translateX(-${target}px)`;
  }

  // Vertical: slide the page up just enough for the row to be fully visible
  ensureRowVisible(rowSelector:string){
    let pageContainer = document.querySelector('.pageContainer') as HTMLElement;
    let row = document.querySelector(`.showOptionsContainer ${rowSelector}`) as HTMLElement;
    if (!pageContainer || !row) return;
    // Rect and computed transform are read at the same instant, so this works mid-transition
    let currentY = new DOMMatrix(getComputedStyle(pageContainer).transform).m42;
    let naturalBottom = row.getBoundingClientRect().bottom - currentY;
    this.setPageOffset(Math.min(0 , window.innerHeight - 40 - naturalBottom));
  }

  setPageOffset(y:number){
    let pageContainer = document.querySelector('.pageContainer') as HTMLElement;
    if (pageContainer) pageContainer.style.transform = `translateY(${y}px)`;
  }

  showYtVid(vidId){
    gsap.timeline().to('.masterContainer' , {
      scale : 1.2 ,
      opacity : 0 ,
      duration : .25 ,
      ease : Power1.easeOut ,
      onComplete : ()=>{
        gsap.set(document.querySelector('.masterContainer'), { clearProps: true });
        this.router.navigateByUrl('/ytplayer/' + vidId);
      }
    })
  }

}
