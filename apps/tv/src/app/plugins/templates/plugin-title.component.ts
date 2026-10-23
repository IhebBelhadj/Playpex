import { Component, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { BackgroundService } from '../../background.service';
import { Navigator } from '../../nav/public-api';
import { ActionModel, CardModel, RowModel, TitleInfoModel } from '../../ui/public-api';
import { PluginClient } from '../plugin-client.service';
import { TitleData } from '../plugin-models';
import { PluginScreen } from './plugin-screen';

interface RowState {
  model:RowModel;
  items:CardModel[];
  page:number;
  last:boolean;
  loading:boolean;
}

// The `title` template (docs/plugins/templates.md): one title of a plugin,
// laid out like the movie page and the 18+ title page (px-detail-layout:
// the title info, the action tiles, rows under them). Its handler gets
// { params }; an action opens its intent or calls the plugin and performs
// what it answers. Back: the navigator's.
@Component({
  selector: 'plugin-title',
  templateUrl: './plugin-title.component.html',
  styleUrls: ['./plugin-title.component.scss'],
})
export class PluginTitleComponent extends PluginScreen implements OnInit {

  info:TitleInfoModel | null = null;
  actions:ActionModel[] = [];
  rows:RowState[] = [];
  error = '';
  private loadSub:Subscription;

  constructor(client:PluginClient, private background:BackgroundService, readonly navigator:Navigator) {
    super(client);
  }

  ngOnInit(): void {
    this.load();
  }

  protected refresh() {
    this.load();
  }

  load() {
    this.loadSub?.unsubscribe();
    this.error = '';
    this.loadSub = this.client.data<TitleData>(this.scope.id, this.decl.data, { params: this.params }).subscribe({
      next: answer => {
        this.client.perform(this.scope, answer.effects);
        let data = answer.data;
        if (!data) {
          this.error = `${this.scope.name} has nothing to show for this title.`;
          return;
        }
        this.info = this.client.info(this.scope, data.info);
        if (this.info.backdrop) this.background.sendImage(this.info.backdrop);
        this.actions = (data.actions || []).map(a => this.client.action(this.scope, a));
        this.rows = (data.rows || []).map(r => this.client.row(this.scope, r)).map(model => 'items' in model.source
          ? { model, items: model.source.items, page: 1, last: true, loading: false }
          : { model, items: [], page: 0, last: false, loading: false });
        this.rows.filter(r => !r.last).forEach(r => this.more(r));
        setTimeout(() => {
          if (!this.screen.ready()) (document.querySelector('.pluginTitle px-action [data-px-item]') as HTMLElement)?.focus({ preventScroll: true });
        }, 0);
      },
      error: () => {
        this.error = `${this.scope.name} didn't answer. Go back and try again.`;
        setTimeout(() => (document.querySelector('.pluginTitle [data-px-key="back"] [data-px-item]') as HTMLElement)?.focus({ preventScroll: true }), 0);
      },
    });
  }

  more(row:RowState) {
    let source = row.model.source;
    if (!('page' in source) || row.last || row.loading) return;
    row.loading = true;
    source.page(row.page + 1).subscribe({
      next: page => {
        row.loading = false;
        row.items = row.items.concat(page.items);
        row.page++;
        row.last = page.last || !page.items.length;
      },
      error: () => {
        row.loading = false;
        row.last = true;
      },
    });
  }

  run(action:ActionModel) {
    if (action.disabled) return;
    action.run?.();
  }

  pick(card:CardModel) {
    card.run?.();
  }

  trackAction(index:number, a:ActionModel) { return a.key; }
  trackRow(index:number, r:RowState) { return r.model.key; }
}
