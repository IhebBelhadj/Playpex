import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { catchError, distinctUntilChanged, filter, map, merge, of, switchMap } from 'rxjs';
import type { Schema } from '@playpex/protocol';
import { ProfilesService } from '../profiles.service';
import { ServerEvents } from '../server-events.service';
import { ServerService } from '../server.service';
import { Toasts } from '../ui/public-api';

type PluginNotification = Schema<'PluginNotification'>;

// What the server's plugins tell a profile (`notify.send`, docs/plugins-plan.md
// §4.10): toasts ("Trakt: 3 titles added to your watch list"). Asked for when
// a profile is chosen and on the event `plugin.notification` naming it; the
// server answers each one once per device and keeps them 24 h, so what came
// while this device was off shows when it's back. Never focusable, never
// a question: a plugin can't ask anything on a client.
@Injectable({
  providedIn: 'root'
})
export class PluginNotifications {

  private started = false;

  constructor(
    private http:HttpClient,
    private server:ServerService,
    private profiles:ProfilesService,
    private events:ServerEvents,
    private toasts:Toasts,
  ) { }

  start() {
    if (this.started) return;
    this.started = true;
    let profile = () => this.profiles.current.value?.id || null;
    merge(
      this.profiles.current.pipe(map(p => p?.id || null), distinctUntilChanged()),
      this.events.on('plugin.notification').pipe(map(e => e.data?.profileId), filter(id => !!id && id == profile())),
    ).pipe(
      filter(id => !!id),
      switchMap(id => this.http.get<{ notifications:PluginNotification[] }>(`${this.server.api}/plugins/notifications`, { params: { profile: id } }).pipe(
        catchError(() => of({ notifications: [] as PluginNotification[] })),
      )),
    ).subscribe(answer => {
      for (let n of answer.notifications || []) {
        this.toasts.show({ text: n.text, detail: n.name, tone: n.tone, key: `plugin:${n.plugin}:${n.key || n.id}` });
      }
    });
  }
}
