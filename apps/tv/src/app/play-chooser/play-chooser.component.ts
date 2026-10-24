import { Component, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { Subscription } from 'rxjs';
import { ChooserLane, ChooserLine, ChooserRequest, PlayChooserService } from '../play-chooser.service';
import { PxPanelComponent } from '../ui/public-api';

// The Play chooser (docs/providers-plan.md §10.2): a panel docked at the
// right edge over the title page, the ways to play in lanes (On this server,
// Stream, Torrent), each lane's best line first, how soon it plays on the
// right. "All N …" shows that lane's full list in place (Back returns to the
// lanes, on the same line); Back on the lanes closes it.
@Component({
  selector: 'play-chooser',
  templateUrl: './play-chooser.component.html',
  styleUrls: ['./play-chooser.component.scss']
})
export class PlayChooserComponent implements OnInit, OnDestroy {

  request:ChooserRequest;
  expanded:ChooserLane | null = null;
  @ViewChild(PxPanelComponent) panel:PxPanelComponent;
  private subscription:Subscription;

  constructor(private chooser:PlayChooserService) { }

  ngOnInit(): void {
    this.subscription = this.chooser.onRequest().subscribe(request => this.open(request));
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
    this.cancel();
  }

  get heading():string {
    if (this.expanded) return this.expanded.more;
    return `${this.request.kind == 'download' ? 'Download' : 'Play'} ${this.request.title}`;
  }

  get emptyTitle():string {
    return this.request.kind == 'download' ? 'Nothing to download this from yet' : 'Nothing to play this from yet';
  }

  get emptyText():string {
    return this.request.kind == 'download' ?
      'Torrents come from sources the server\'s admin adds on its dashboard, under Plugins.' :
      'Files on this server play here. Streams and torrents come from sources the server\'s admin adds on its dashboard, under Plugins.';
  }

  open(request:ChooserRequest){
    // a new request while one is open takes its place
    this.request?.cancel();
    let reopened = !!this.request;
    this.request = request;
    this.expanded = null;
    if (reopened) this.panel?.focusItem();
  }

  pick(line:ChooserLine){
    let request = this.request;
    this.request = undefined;
    this.expanded = null;
    this.panel?.finish();
    request?.pick(line.source);
  }

  expand(lane:ChooserLane){
    this.expanded = lane;
    this.panel?.focusItem();
  }

  // Back: the full list → the lanes (on its "All …" line), else close
  back(){
    if (this.expanded) {
      let group = this.expanded.group;
      this.expanded = null;
      this.panel?.focusItem(`[data-px-key="more:${group}"]`);
      return;
    }
    this.close();
  }

  close(){
    let request = this.request;
    this.request = undefined;
    this.expanded = null;
    this.panel?.finish();
    request?.cancel();
  }

  cancel(){
    let request = this.request;
    this.request = undefined;
    this.expanded = null;
    request?.cancel();
  }

  byLine(index:number, line:ChooserLine){
    return line.source.id;
  }
}
