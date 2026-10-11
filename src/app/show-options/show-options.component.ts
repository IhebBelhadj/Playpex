import { Location } from '@angular/common';
import { Component, AfterViewInit, OnDestroy } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { distinctUntilChanged, Subject, Subscription, switchMap, map } from 'rxjs';
import { gsap, Power1 } from 'gsap'
import { MenuServiceService } from '../menu-service.service';
import { MoviesService } from '../movies.service';
import { NavigationService } from '../navigation.service';
import { NotificationService } from '../notification.service';
import { PlaybackService } from '../playback.service';
import { TorrentService } from '../torrent.service';

// TV show page (/shows/show/:id): Play / Trailer, a seasons row and the
// selected season's episodes. Space on an episode finds the best torrent
// (EZTV + TheRARBG via the local server) and starts the player.
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

  playEpisode(ep){
    if (!ep || this.resolvingEpisode !== undefined) return;
    let code = this.episodeCode(this.selectedSeason , ep.episode_number);

    if (ep.upcoming) {
      this.notificationService.sendNotification("error" , `${code} hasn't aired yet`);
      return;
    }
    if (!this.imdbId) {
      this.notificationService.sendNotification("error" , "This show has no IMDb id, so torrents can't be looked up");
      return;
    }

    this.resolvingEpisode = ep.episode_number;
    this.torrentService.findEpisodeTorrents(this.imdbId , this.show['name'] , this.selectedSeason , ep.episode_number)
      .subscribe(result => {
        this.resolvingEpisode = undefined;
        let best = result.torrents[0];
        if (!best) {
          let reason = result.providerErrors ? " (some providers are unreachable)" : "";
          this.notificationService.sendNotification("error" , `No torrents found for ${code}${reason}`);
          return;
        }

        this.playback.play({
          title : this.show['name'],
          subtitle : `${code} · ${ep.name}`,
          year : (ep.air_date || '').slice(0, 4),
          runtimeMinutes : ep.runtime,
          magnet : best.magnet,
          imdbId : this.imdbId,
          season : this.selectedSeason,
          episode : ep.episode_number,
        });
        this.router.navigateByUrl('/player');
      } , () => {
        this.resolvingEpisode = undefined;
        this.notificationService.sendNotification("error" , "Couldn't reach the torrent providers. Try again later");
      })
  }

  episodeCode(season , episode){
    let pad = n => (n < 10 ? '0' : '') + n;
    return `S${pad(season)}E${pad(episode)}`;
  }

  // Spatial navigation focus: remember position per row, scroll rows into view
  onFocus(node:HTMLElement){
    if (!this.router.url.includes('/shows/show') || !node.closest('.showOptionsContainer')) return;

    if (node.closest('.optionPannel')) {
      this.updateLastSelected('.optionPannel' , node);
      this.setPageOffset(0);
    }
    else if (node.classList.contains('season')) {
      this.updateLastSelected('.seasons' , node);
      this.scrollRowTo(node);
      this.ensureRowVisible('.seasons');
      this.seasonRequests.next({ showId : this.show['id'] , season : Number(node.dataset['season']) });
    }
    else if (node.classList.contains('episodeBtn')) {
      this.updateLastSelected('.episodes' , node);
      this.scrollRowTo(node);
      this.ensureRowVisible('.episodes');
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
