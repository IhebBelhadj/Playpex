import { Component } from '@angular/core';
import { CardModel, Navigator, RowModel, TitleInfoModel, useScreen } from './hello-api';
import { helloPage, helloTitle } from './hello-data';

// plugin.hello.section: a section of the example plugin, from the UI system
// only (docs/tv-plugins.md): px-section-layout, a title info following the
// focused card, a paged row of view models.
@Component({
  selector: 'hello-section',
  template: `
    <px-section-layout class="helloSection" pxSection="plugin.hello.section" [leaveFor]="{ left: '@menu' }">
      <px-title-info class="info" [info]="info" layout="section"></px-title-info>
      <div class="rows" pxStack="hello" align="row-top" motion="transform">
        <div pxTrack>
          <px-card-row pxStackItem [rowKey]="row.key" [title]="row.title" [items]="items" [loadAhead]="6"
            (nearEnd)="more()" (picked)="open($event)" (focusin)="focus($event)"></px-card-row>
        </div>
      </div>
    </px-section-layout>`,
  styleUrls: ['./hello-section.component.scss'],
})
export class HelloSectionComponent {

  private screen = useScreen();

  readonly row:RowModel = { key: 'hello:all', title: 'Made-up titles', source: { page: helloPage } };
  items:CardModel[] = [];
  info:TitleInfoModel = { title: 'Hello', overview: 'The example plugin\'s own section. Move along the row.' };
  private page = 0;
  private last = false;

  constructor(private navigator:Navigator) {
    this.more();
  }

  more() {
    if (this.last) return;
    helloPage(++this.page).subscribe(page => {
      this.items = [...this.items, ...page.items];
      this.last = page.last;
    });
  }

  focus(e:FocusEvent) {
    let key = (e.target as HTMLElement).dataset?.['pxKey'];
    let id = Number(key?.split(':')[1]);
    if (!id) return;
    let t = helloTitle(id);
    this.info = { title: t.title, meta: [{ kind: 'text', text: t.year }, { kind: 'chip', text: 'Example' }], overview: t.overview };
  }

  open(card:CardModel) {
    if (card.intent) this.navigator.open(card.intent);
  }
}
