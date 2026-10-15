import { AfterViewInit, Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Location } from '@angular/common';
import { catchError, of, Subscription, switchMap } from 'rxjs';
import { NavigationService } from '../navigation.service';
import { BackgroundService } from '../background.service';
import { NotificationService } from '../notification.service';
import { TorrentService } from '../torrent.service';
import { TorrentPickerService } from '../torrent-picker.service';
import { PlaybackService } from '../playback.service';
import { AdultService, AdultTitle, AdultTitleDetails, EMPTY_ADULT_STATE, MetaProvider } from '../adult.service';

const PERFORMERS_SHOWN = 6;

// /adult/title/:provider/:id — one 18+ title from a metadata provider, laid out
// like the movie page. Play finds its torrents by title + year (TheRARBG XXX +
// The Pirate Bay, server lib/adult.js) → torrent picker → player; nothing is
// saved to the profile. "Find releases" opens the compact list searched for it.
@Component({
  selector: 'app-adult-title',
  templateUrl: './adult-title.component.html',
  styleUrls: ['./adult-title.component.scss']
})
export class AdultTitleComponent implements OnInit, AfterViewInit, OnDestroy {

  providerId = '';
  provider:MetaProvider | null = null;
  item:AdultTitle | null = null;
  details:AdultTitleDetails | null = null;
  more:AdultTitle[] = [];
  error = '';
  findingTorrents = false;

  private paramSub:Subscription;
  private navSub:Subscription;

  constructor(
    private adult:AdultService,
    private navigation:NavigationService,
    private background:BackgroundService,
    private notification:NotificationService,
    private torrents:TorrentService,
    private torrentPicker:TorrentPickerService,
    private playback:PlaybackService,
    private route:ActivatedRoute,
    private router:Router,
    private location:Location,
  ) { }

  get studio() {
    return this.details?.studio || this.item?.studio || null;
  }

  get performers() {
    return (this.details?.performers || []).slice(0, PERFORMERS_SHOWN);
  }

  get morePerformers():number {
    return Math.max(0, (this.details?.performers?.length || 0) - PERFORMERS_SHOWN);
  }

  ngOnInit(): void {
    // "More from" opens another title on this same page
    this.paramSub = this.route.paramMap.pipe(
      switchMap(params => {
        this.providerId = params.get('provider');
        this.adult.metaProviders().subscribe(list => this.provider = list.find(p => p.id == this.providerId) || null);
        let id = params.get('id');
        let opened = this.adult.openedTitle;
        this.item = opened?.id == id ? opened : null;
        this.details = opened && 'performers' in opened ? opened as AdultTitleDetails : null;
        this.more = [];
        this.error = '';
        if (this.item?.backdrop) this.background.sendImage(this.item.backdrop);
        return this.adult.title(this.providerId, id).pipe(catchError(() => of(null)));
      }),
    ).subscribe(details => {
      if (!details) {
        if (!this.item) this.error = "Couldn't load this title. Check your connection, then go back and try again.";
        setTimeout(() => this.focusSelector('.adultTitle .actionBtn'), 0);
        return;
      }
      this.details = details;
      this.item = this.item || details;
      if (details.backdrop) this.background.sendImage(details.backdrop);
      this.loadMore(details);
      setTimeout(() => this.focusSelector('.adultTitle [data-action="play"]'), 0);
    });
  }

  // Section `adultTitle` is a pxSection in the template; the page is a pxStack
  // (actions, "More from" row) scrolling natively (src/app/movement)
  ngAfterViewInit(): void {
    this.navigation.updateNavigation('add', {
      id: 'menu',
      selector: '.menuContainer .element',
      restrict: 'self-only',
      leaveFor: { right: '@adultTitle' },
    });
    setTimeout(() => this.focusSelector('.adultTitle [data-action="play"]'), 0);

    this.navSub = this.navigation.executeCommand().subscribe(instruction => {
      if (!this.router.url.startsWith('/adult/title/')) return;
      let active = document.activeElement as HTMLElement;
      if (instruction == 'back') {
        if (active.classList.contains('menuItem')) this.focusSelector('.adultTitle [data-action="play"]');
        else this.location.back();
        return;
      }
      if (instruction != 'click' || active.classList.contains('menuItem')) return;
      let action = active.dataset['action'];
      if (action == 'play') this.play();
      else if (action == 'releases') this.findReleases();
      else if (action == 'back') this.location.back();
      else if (active.classList.contains('card')) this.open(this.more[Number(active.dataset['index'])]);
    });
  }

  ngOnDestroy(): void {
    this.paramSub?.unsubscribe();
    this.navSub?.unsubscribe();
    this.navigation.updateNavigation('remove', { sectionId: 'menu' });
  }

  // ── actions ─────────────────────────────────────────────────────────────

  private play() {
    let item = this.item;
    if (!item || this.findingTorrents) return;
    this.findingTorrents = true;
    this.torrents.findAdultTorrents(item.title, item.year ? String(item.year) : '').subscribe({
      next: result => {
        this.findingTorrents = false;
        if (!result.torrents.length) {
          let reason = result.providerErrors ? ' Some torrent sources are unreachable right now.' : '';
          this.notification.sendNotification('error', `No torrents found for ${item.title}. Try Find releases to search by other words.${reason}`);
          return;
        }
        let options = result.torrents.map((t, i) => TorrentPickerService.fromEpisode(t, i));
        this.torrentPicker.choose(item.title, options).subscribe(choice => {
          let t = choice.torrent;
          this.playback.play({
            title: item.title,
            subtitle: [this.studio?.name, item.year, t['quality']].filter(Boolean).join('  ·  '),
            magnet: t['magnet'],
            adult: true,
          });
          this.router.navigateByUrl('/player');
        });
      },
      error: () => {
        this.findingTorrents = false;
        this.notification.sendNotification('error', "Couldn't search for torrents. Check that the Playpex server is running.");
      }
    });
  }

  // The compact list, searched for this title on the current release source
  private findReleases() {
    if (!this.item) return;
    this.adult.state = { ...EMPTY_ADULT_STATE, provider: this.adult.state.provider, query: this.item.title };
    this.router.navigateByUrl('/adult/releases');
  }

  private open(item:AdultTitle | undefined) {
    if (!item) return;
    this.adult.openedTitle = item;
    this.router.navigateByUrl(`/adult/title/${this.providerId}/${encodeURIComponent(item.id)}`);
  }

  // ── "More from <studio>" ────────────────────────────────────────────────

  private loadMore(details:AdultTitleDetails) {
    if (!details.browsableStudio) return;
    this.adult.row(this.providerId, `studio:${details.browsableStudio}`).pipe(catchError(() => of(null))).subscribe(page => {
      if (page && this.details?.id == details.id) this.more = page.items.filter(i => i.id != details.id);
    });
  }

  // ── view helpers ────────────────────────────────────────────────────────

  runtime(minutes:number | null):string {
    if (!minutes) return '';
    let h = Math.floor(minutes / 60), m = minutes % 60;
    return h ? `${h}h ${m}m` : `${m}m`;
  }

  initials(name:string):string {
    return name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  }

  private focusSelector(selector:string) {
    (document.querySelector(selector) as HTMLElement)?.focus({ preventScroll: true });
  }
}
