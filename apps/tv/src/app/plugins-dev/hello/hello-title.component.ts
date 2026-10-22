import { Component } from '@angular/core';
import { Dialogs, MetaItem, TitleInfoModel, Toasts, useScreen } from './hello-api';
import { helloTitle } from './hello-data';

// plugin.hello.title: the example plugin's detail screen (params { id }):
// px-detail-layout, the title info, an action bar whose action asks with
// Dialogs.confirm and answers with a toast. Back: the navigator's pop.
@Component({
  selector: 'hello-title',
  template: `
    <px-detail-layout class="helloTitle" pxSection="plugin.hello.title" [leaveFor]="{ left: '@menu' }" pxStack>
      <px-title-info [info]="info" layout="detail"></px-title-info>
      <div class="options">
        <px-action-bar>
          <px-action key="hello:wave" icon="film" label="Say hello" (pxSelect)="wave()"></px-action>
        </px-action-bar>
      </div>
    </px-detail-layout>`,
  styleUrls: ['./hello-title.component.scss'],
})
export class HelloTitleComponent {

  private screen = useScreen<{ id:string }>();
  info:TitleInfoModel;

  constructor(private dialogs:Dialogs, private toasts:Toasts) {
    let t = helloTitle(Number(this.screen.params.id) || 1);
    let meta:MetaItem[] = [{ kind: 'text', text: t.year }, { kind: 'chip', text: 'Example plugin' }];
    this.info = { title: t.title, meta, overview: t.overview };
  }

  wave() {
    this.dialogs.confirm({ title: 'Say hello?', text: 'Dialogs.confirm from a plugin: true on OK, false on Back.', confirm: 'Hello', cancel: 'Not now' })
      .subscribe(yes => yes && this.toasts.show({ text: 'Hello from the example plugin', tone: 'success', key: 'hello' }));
  }
}
