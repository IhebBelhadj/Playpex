import { Component } from '@angular/core';
import { Dialogs } from '../overlay/dialogs.service';

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

  constructor(private dialogs:Dialogs) { }

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
