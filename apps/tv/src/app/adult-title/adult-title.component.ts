import { MetaItem, TitleInfoModel } from '../ui/public-api';
import { MediaKeys } from '../media-keys.service';
import { AfterViewInit, Component, OnDestroy, OnInit, inject } from '@angular/core';
import { catchError, of, Subscription } from 'rxjs';
import { NavigationService } from '../navigation.service';
import { BackgroundService } from '../background.service';
import { NotificationService } from '../notification.service';
import { TorrentService } from '../torrent.service';
import { TorrentPickerService } from '../torrent-picker.service';
import { PlaybackService } from '../playback.service';
import { AdultService, AdultTitle, AdultTitleDetails, MetaProvider } from '../adult.service';
import { ReleasesService } from '../releases.service';
import { Navigator, useScreen } from '../nav/public-api';

// /adult/title/:provider/:id — one 18+ title from a metadata provider, laid out
// and styled like the movie page (title info, action tiles, cast row, "More
// from <studio>" row). Play finds its torrents by title + year (TheRARBG XXX +
// The Pirate Bay, server lib/adult.js) → torrent picker → player; nothing is
// saved to the profile. "Find releases" opens the compact list searched for
// the title, Enter on a performer searches it for them. Screen core.adult.title
// (src/app/nav): params { provider, id }, payload the title as listed (it
// renders before the details arrive).
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

  private titleSub:Subscription;
  private screen = useScreen<{ provider:string, id:string }, AdultTitle>();
  // a remote's Play key = the Play button (§13.2)
  private mediaSub = inject(MediaKeys).for(this.screen).subscribe(a => (a == 'playPause' || a == 'play') && this.play());

  constructor(
    private adult:AdultService,
    private releases:ReleasesService,
    private navigation:NavigationService,
    private background:BackgroundService,
    private notification:NotificationService,
    private torrents:TorrentService,
    private torrentPicker:TorrentPickerService,
    private playback:PlaybackService,
    public navigator:Navigator,
  ) { }

  // the title block (<px-title-info>): year, the 18+ seal, studio, runtime,
  // the provider's rating; director; overview
  get titleInfo():TitleInfoModel {
    let item = this.item;
    let meta:MetaItem[] = [];
    if (item.year) meta.push({ kind: 'text', text: String(item.year) });
    meta.push({ kind: 'seal', text: '18+' });
    if (this.studio) meta.push({ kind: 'chip', text: this.studio.name });
    if (this.details?.runtime) meta.push({ kind: 'chip', text: this.runtime(this.details.runtime) });
    if (item.rating) meta.push({ kind: 'score', source: 'provider', value: item.rating, label: this.provider?.name || '' });
    return {
      title: item.title,
      meta,
      notes: this.details?.director ? ['Directed by ' + this.details.director] : [],
      overview: item.overview || '',
    };
  }

  get studio() {
    return this.details?.studio || this.item?.studio || null;
  }

  ngOnInit(): void {
    let { provider, id } = this.screen.params;
    this.providerId = provider;
    this.adult.metaProviders().subscribe(list => this.provider = list.find(p => p.id == this.providerId) || null);
    let opened = this.screen.payload;
    this.item = opened?.id == id ? opened : null;
    this.details = opened && 'performers' in opened ? opened as AdultTitleDetails : null;
    if (this.item?.backdrop) this.background.sendImage(this.item.backdrop);
    this.titleSub = this.adult.title(this.providerId, id).pipe(catchError(() => of(null))).subscribe(details => {
      if (!details) {
        if (!this.item) this.error = "Couldn't load this title. Check your connection, then go back and try again.";
        setTimeout(() => this.focusSelector('.adultTitle .option'), 0);
        return;
      }
      this.details = details;
      this.item = this.item || details;
      if (details.backdrop) this.background.sendImage(details.backdrop);
      this.loadMore(details);
      setTimeout(() => this.focusStart(), 0);
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
    setTimeout(() => this.focusStart(), 0);

    // Back on the menu: into the page again (then out, the nav system's pop)
    this.screen.onBack(() => {
      if (!document.activeElement?.classList.contains('menuItem')) return false;
      this.focusSelector('.adultTitle [data-px-key="play"]');
      return true;
    });
  }

  ngOnDestroy(): void {
    this.mediaSub.unsubscribe();
    this.titleSub?.unsubscribe();
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
        });
      },
      error: () => {
        this.findingTorrents = false;
        this.notification.sendNotification('error', "Couldn't search for torrents. Check that the Playpex server is running.");
      }
    });
  }

  // The compact list, searched for this title (or a performer) on the current
  // release source
  findReleases(query:string | undefined) {
    if (!query) return;
    this.releases.open('adult', query, { label: this.item?.title || query });
  }

  // "More from": that title's page, over this one
  open(item:AdultTitle | undefined) {
    if (!item) return;
    this.navigator.open({ screen: 'core.adult.title', params: { provider: this.providerId, id: item.id }, payload: item });
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

  byName = (i:number, p:any) => p.name;
  byId = (i:number, m:any) => m.id;

  initials(name:string):string {
    return name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  }

  // Play, or back from the player / a release list: what was focused
  private focusStart() {
    if (!this.screen.ready()) this.focusSelector('.adultTitle [data-px-key="play"]');
  }

  private focusSelector(selector:string) {
    (document.querySelector(selector) as HTMLElement)?.focus({ preventScroll: true });
  }
}
