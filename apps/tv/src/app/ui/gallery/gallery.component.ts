import { Component } from '@angular/core';
import { Dialogs } from '../overlay/dialogs.service';
import { Toasts, ToastTone } from '../toast/toasts.service';
import { ActionModel, MetaItem, TitleInfoModel } from '../models';
import { MovieContext } from '../slots/slots';
import { TabModel } from '../controls/px-tabs.component';
import { dp } from '../units';

// core.dev.gallery (development builds only, docs/ui-system-plan.md §5.7): every
// token and primitive of the UI system in every state, with fixture data. Where
// primitives are built and checked, and the deterministic half of the visual
// checks (scripts/screens.js): real pages show live TMDB data.
@Component({
  selector: 'px-gallery',
  templateUrl: './gallery.component.html',
  styleUrls: ['./gallery.component.scss'],
})
export class GalleryComponent {

  readonly text = ['text', 'text-soft', 'text-secondary', 'text-muted', 'text-dim', 'text-faint'];

  readonly meaning = ['progress', 'on', 'live', 'positive', 'caution', 'warn', 'danger', 'error'];

  readonly surfaces = [
    'surface-1', 'surface-2', 'surface-3', 'surface-control', 'surface-tile', 'surface-option',
    'surface-card', 'surface-chip', 'surface-score', 'surface-row', 'surface-pane', 'surface-badge',
    'surface-raised', 'surface-solid', 'surface-field', 'scrim-panel',
  ];

  readonly fonts = [
    { token: 'font-bold', sample: 'Heat' },
    { token: 'font-book', sample: 'Obsessive master thief Neil McCauley leads a crew' },
    { token: 'font-light', sample: '1995 · 2 h 50 min' },
    { token: 'font-display', sample: 'Trending' },
  ];

  readonly radii = ['radius-xs', 'radius-s', 'radius-m', 'radius-l', 'radius-xl', 'radius-pill'];

  readonly spaces = [1, 2, 3, 4, 5, 6, 7, 8].map(n => 'space-' + n);

  // overlays: what the last one answered
  result = 'Back closes any of them';
  panel = false;
  readonly panelChips = ['Any', '4K', '1080p', '720p'];
  panelChoice = 'Any';

  // atoms (step 3)
  readonly actionModels:ActionModel[] = [
    { key: 'g-model', label: 'Watch party', icon: 'tv' },
    { key: 'g-model-on', label: 'Following', icon: 'bookmark', on: true },
  ];
  readonly plateWidth = dp(380);
  switchOn = true;
  volume = 70;
  readonly percent = (v:number) => v + ' %';
  readonly tabs:TabModel[] = [
    { key: 'subtitles', label: 'Subtitles' }, { key: 'style', label: 'Size & timing' }, { key: 'audio', label: 'Audio' },
  ];
  tab = 'subtitles';
  readonly meta:MetaItem[] = [
    { kind: 'text', text: '1995' }, { kind: 'chip', text: '1080p' }, { kind: 'chip', text: '2160p' },
    { kind: 'score', source: 'imdb', value: 8.3 }, { kind: 'score', source: 'tmdb', value: 7.9 }, { kind: 'seal', text: '18+' },
  ];

  // cards: every variant, with and without artwork, every badge / state
  readonly cards:any[] = [
    { key: 'p1', variant: 'poster', title: 'No artwork: the title instead', progress: 0.4 },
    { key: 'p2', variant: 'poster', title: 'A broken image', image: 'assets/does-not-exist.jpg', badges: ['tv'] },
    { key: 'c1', variant: 'compact', title: 'Compact, a long title that is cut', subtitle: '1995', badges: [{ text: 'New' }] },
    { key: 'r1', variant: 'portrait', title: 'Al Pacino', subtitle: 'Lt. Vincent Hanna' },
    { key: 's1', variant: 'still', title: 'Pilot', number: 1, rating: { source: 'imdb', value: 9.1 }, meta: ['59 min', '20 Jan 2008'], badges: ['current'] },
    { key: 's2', variant: 'still', title: 'Cat\'s in the Bag…', number: 2, badges: ['watched'] },
    { key: 's3', variant: 'still', title: 'Gray Matter', number: 5, progress: 0.6, busy: true },
    { key: 's4', variant: 'still', title: 'Next season', number: 1, badges: ['upcoming'], dim: true },
  ];
  readonly byKey = (i:number, c:any) => c.key;
  readonly titleInfo:TitleInfoModel = {
    eyebrow: 'An eyebrow line',
    title: 'Heat',
    meta: [{ kind: 'text', text: '1995' }, { kind: 'chip', text: '1080p' }, { kind: 'score', source: 'imdb', value: 8.3, votes: '712K' }],
    genres: ['Crime', 'Drama', 'Action'],
    notes: ['Directed by Michael Mann'],
    status: 'Resume from 1:02:10',
    progress: 0.37,
    overview: 'Obsessive master thief Neil McCauley leads a top-notch crew on various daring heists throughout Los Angeles while determined detective Vincent Hanna pursues him without rest.',
    credits: [{ label: 'Written by', names: ['Michael Mann'] }],
  };
  readonly slotContext:MovieContext = {
    movie: { tmdbId: 949, imdbId: 'tt0113277', title: 'Heat', year: '1995' },
    profile: { id: 'gallery', name: 'Gallery', kids: false },
  };

  constructor(private dialogs:Dialogs, private toasts:Toasts) { }

  toast(tone:ToastTone) {
    let text = { info: 'Subtitles loaded', success: 'Added to your watch list', error: "Couldn't save the setting" }[tone];
    this.toasts.show({ text, tone, key: tone == 'error' ? undefined : 'gallery', detail: tone == 'error' ? 'The server didn\'t answer. It will be tried again.' : undefined });
  }

  toastQueue() {
    for (let i = 1; i <= 4; i++) this.toasts.show({ text: 'Toast ' + i + ' of 4 (the first is dropped)', durationMs: 1500 });
  }

  choose() {
    this.dialogs.choose({
      title: 'Choose a quality',
      subtitle: 'Dialogs.choose: emits the value, completes empty on Back',
      choices: [
        { key: 'uhd', label: '2160p', detail: 'May not play here', value: 2160 },
        { key: 'hd', label: '1080p', detail: 'Best match', value: 1080, progress: 0.3 },
        { key: 'sd', label: '720p', value: 720 },
      ],
      focus: 'hd',
    }).subscribe({ next: value => this.result = 'choose: ' + value, complete: () => this.result += ' (completed)' });
  }

  confirm() {
    this.dialogs.confirm({ title: 'Delete this profile?', text: 'Back answers false.', confirm: 'Delete', cancel: 'Keep' })
      .subscribe(yes => this.result = 'confirm: ' + yes);
  }

  alert() {
    this.dialogs.alert({ text: 'Something went wrong. Dialogs.alert emits once it is dismissed.' })
      .subscribe(() => this.result = 'alert: dismissed');
  }
}
