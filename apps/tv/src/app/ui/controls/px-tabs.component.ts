import { ChangeDetectionStrategy, Component, ElementRef, EventEmitter, Input, NgZone, OnDestroy, OnInit, Output } from '@angular/core';

export interface TabModel {
  key:string;
  label:string;
}

// A row of tabs over content: moving onto a tab shows it (no Enter needed);
// the shown one has a white bar under it, the focused one is a white pill.
// Put it and the tab's content in one pxStack, so Up from the content always
// comes back to the shown tab (a pxGrid entered on `.selected`):
//
//   <div pxStack="settings">
//     <px-tabs gridId="settingsTabs" [tabs]="tabs" [active]="tab" (activeChange)="tab = $event"></px-tabs>
//     <ng-container *ngIf="tab == 'audio'">…</ng-container>
//   </div>
//
// Item keys are 'tab:<key>'; each button has data-tab="<key>".
// `vertical`: a column of larger tabs, the rail of a <px-rail-layout> (Settings).
@Component({
  selector: 'px-tabs',
  templateUrl: './px-tabs.component.html',
  styleUrls: ['./px-tabs.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PxTabsComponent implements OnInit, OnDestroy {
  @Input() gridId = '';
  @Input() tabs:TabModel[] = [];
  @Input() active:string | null = null;
  @Input() vertical = false;
  @Output() activeChange = new EventEmitter<string>();

  // sn:focused bubbles from the focused button (the FocusEngine's focus too,
  // also in a window without OS focus)
  private focused = (e:Event) => {
    let key = (e.target as HTMLElement)?.dataset?.['tab'];
    if (key && key != this.active && this.host.nativeElement.contains(e.target as Node)) {
      this.zone.run(() => {
        this.active = key;
        this.activeChange.emit(key);
      });
    }
  };

  constructor(private host:ElementRef<HTMLElement>, private zone:NgZone) { }

  ngOnInit(): void {
    this.host.nativeElement.addEventListener('sn:focused', this.focused);
  }

  ngOnDestroy(): void {
    this.host.nativeElement.removeEventListener('sn:focused', this.focused);
  }

  byKey(i:number, t:TabModel) { return t.key; }
}
