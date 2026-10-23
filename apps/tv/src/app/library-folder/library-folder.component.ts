import { AfterViewInit, Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { FocusEngine } from '../movement/movement';
import { useScreen } from '../nav/public-api';
import { NavigationService } from '../navigation.service';
import { PlaybackService } from '../playback.service';
import { ServerLibraryFolder, ServerLibraryService, ServerLibraryVideo } from '../server-library.service';

// What the folder card of the Library section passes
export interface LibraryFolderPayload {
  name:string;
}

// /library/folder/:id — a library folder's other videos (docs/media-server-plan.md
// §5.5): files not matched to a movie or a show, one level at a time, folders
// first, natural name order. Enter on a folder goes into it (an in-page step:
// Back comes up again, onto that folder, then out of the screen); Enter on a
// video plays it by its media ref (no torrent; nothing saved to the profile:
// it's no TMDB title). The level shown and the focused row per level live in
// the history entry, so the way back from the player finds them.
@Component({
  selector: 'app-library-folder',
  templateUrl: './library-folder.component.html',
  styleUrls: ['./library-folder.component.scss']
})
export class LibraryFolderComponent implements OnInit, AfterViewInit, OnDestroy {

  listing:ServerLibraryFolder | null = null;
  loading = false;
  loadError = '';

  private subscriptions:Subscription[] = [];
  private request:Subscription | null = null;
  private screen = useScreen<{ id:string }, LibraryFolderPayload>();

  constructor(
    private serverLibrary:ServerLibraryService,
    private playback:PlaybackService,
    private navigation:NavigationService,
    private engine:FocusEngine,
  ) { }

  // the level shown ('' = the folder itself) and the row focused on each level
  private get path():string {
    return this.screen.state('path', () => '');
  }

  private get focusedByPath():Record<string, string> {
    return this.screen.state('focused', () => ({}));
  }

  get name():string {
    return this.listing?.folder.name || this.screen.payload?.name || 'Other videos';
  }

  // "Downloads / Clips / Holiday"
  get trail():string[] {
    let parts = this.listing?.path ? this.listing.path.split('/') : [];
    return [this.name, ...parts];
  }

  get count():string {
    if (!this.listing) return '';
    let folders = this.listing.folders.length, videos = this.listing.videos.length;
    let said = [];
    if (folders) said.push(folders == 1 ? '1 folder' : `${folders} folders`);
    if (videos) said.push(videos == 1 ? '1 video' : `${videos} videos`);
    return said.join(', ');
  }

  ngOnInit():void {
    this.load(this.path);
    // the server found or lost files: this level again
    this.subscriptions.push(this.serverLibrary.changes.subscribe(() => this.load(this.path, false)));
  }

  ngAfterViewInit():void {
    this.navigation.updateNavigation('add', {
      id: 'menu',
      selector: '.menuContainer .element',
      restrict: 'self-only',
      leaveFor: { right: this.engine.target(['grid:library-folder', '@libraryFolder']) },
    });
    // Back: up one level onto the folder we came from; at the top, out of the screen
    this.screen.onBack(() => {
      if (!this.listing || this.listing.parent === null) return false;
      this.go(this.listing.parent);
      return true;
    });
  }

  ngOnDestroy():void {
    this.request?.unsubscribe();
    this.subscriptions.forEach(s => s.unsubscribe());
    this.navigation.updateNavigation('remove', { sectionId: 'menu' });
  }

  load(path:string, focus = true) {
    this.request?.unsubscribe();
    this.loading = true;
    this.loadError = '';
    this.request = this.serverLibrary.folder(this.screen.params.id, path).subscribe({
      next: listing => {
        this.loading = false;
        this.listing = listing;
        this.screen.setState('path', listing.path);
        if (focus) setTimeout(() => this.focusRemembered(), 0);
      },
      error: err => {
        this.loading = false;
        // a level that's gone (moved, deleted): its parent, else the folder
        if (err?.status == 404 && path) {
          this.load(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', focus);
          return;
        }
        if (!focus && this.listing) return;
        this.listing = null;
        this.loadError = err?.status == 404
          ? 'This folder has no other videos any more.'
          : "Couldn't open this folder. Check that the Playpex server is running, then try again.";
        setTimeout(() => this.focusKey('retry'), 0);
      },
    });
  }

  retry() {
    this.load(this.path);
  }

  // Into a subfolder, or up to the parent (focusing the folder we came from)
  private go(path:string) {
    let from = this.listing?.path || '';
    if (path.length < from.length) {
      let child = from.slice(path ? path.length + 1 : 0).split('/')[0];
      this.focusedByPath[path] = `folder:${child}`;
    }
    this.load(path);
  }

  openFolder(folder:{ path:string }) {
    this.go(folder.path);
  }

  play(video:ServerLibraryVideo) {
    this.focusedByPath[this.listing.path] = `video:${video.id}`;
    this.playback.play({
      title: video.name.replace(/\.[a-z0-9]{2,4}$/i, ''),
      subtitle: this.trail.join(' / '),
      source: { ref: video.ref },
    });
  }

  // remember the row as it gets focus (the way back from the player, or up a level)
  remember(key:string) {
    if (this.listing) this.focusedByPath[this.listing.path] = key;
  }

  private focusRemembered() {
    let key = this.focusedByPath[this.listing?.path ?? ''];
    if (!(key && this.focusKey(key))) {
      let first = document.querySelector('.libraryFolder .row') as HTMLElement;
      first?.focus({ preventScroll: true });
    }
  }

  private focusKey(key:string):boolean {
    let el = document.querySelector(`.libraryFolder [data-px-key="${CSS.escape(key)}"]`) as HTMLElement;
    el?.focus({ preventScroll: true });
    return !!el;
  }

  // ── row text ──────────────────────────────────────────────────────────────

  videoMeta(video:ServerLibraryVideo):string[] {
    let meta = [];
    if (video.quality) meta.push(video.quality == '2160p' ? '4K' : video.quality);
    if (video.duration) meta.push(duration(video.duration));
    meta.push(size(video.size));
    return meta;
  }

  byFolder = (i:number, f:{ path:string }) => f.path;
  byVideo = (i:number, v:ServerLibraryVideo) => v.id;
}

function duration(seconds:number):string {
  let m = Math.round(seconds / 60);
  if (m < 60) return `${Math.max(1, m)} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function size(bytes:number):string {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes >= 1e6) return Math.round(bytes / 1e6) + ' MB';
  return Math.max(1, Math.round(bytes / 1e3)) + ' KB';
}
