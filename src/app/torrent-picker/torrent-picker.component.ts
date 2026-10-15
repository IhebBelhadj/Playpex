import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { NavigationService } from '../navigation.service';
import { TorrentPickRequest, TorrentPickerService } from '../torrent-picker.service';

// Modal list of torrents shown before playback (movies and episodes).
// Own trapping section (pxSection) over a scrolling list (pxGrid);
// AppComponent forwards select/back here while open.
@Component({
  selector: 'torrent-picker',
  templateUrl: './torrent-picker.component.html',
  styleUrls: ['./torrent-picker.component.scss']
})
export class TorrentPickerComponent implements OnInit , OnDestroy {

  request:TorrentPickRequest;
  private previousFocus:HTMLElement;
  private subscriptions:Subscription[] = [];

  constructor(
    private picker:TorrentPickerService,
    private navigation:NavigationService,
  ) { }

  ngOnInit(): void {
    this.subscriptions.push(
      this.picker.onRequest().subscribe(request => this.open(request)),
      this.picker.onCommand().subscribe(action => {
        if (action == 'select') this.pickFocused();
        if (action == 'back') this.close();
      }),
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach(s => s.unsubscribe());
  }

  open(request:TorrentPickRequest){
    if (this.request) this.request.cancel();
    this.request = request;
    this.picker.isOpen = true;
    this.previousFocus = document.activeElement as HTMLElement;

    // wait for the options to render
    setTimeout(() => {
      let list = document.querySelector('.torrentPicker .options') as HTMLElement;
      if (list) list.scrollTop = 0;
      this.navigation.updateNavigation('focus' , {sectionId : 'torrentPicker'});
    } , 0);
  }

  pickFocused(){
    let active = document.activeElement as HTMLElement;
    if (!this.request || !active.classList.contains('torrentOption')) return;
    let option = this.request.options[Number(active.dataset['index'])];
    this.close(() => this.request.pick(option));
  }

  close(done = () => this.request?.cancel()){
    if (!this.request) return;
    this.previousFocus?.focus({preventScroll : true});
    done();
    this.request = undefined;
    this.picker.isOpen = false;
  }

}
