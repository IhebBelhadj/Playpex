import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { NavigationService } from '../navigation.service';
import { TorrentPickRequest, TorrentPickerService } from '../torrent-picker.service';

// Modal list of torrents shown before playback (movies and episodes).
// Own spatial-nav section; AppComponent forwards select/back here while open.
@Component({
  selector: 'torrent-picker',
  templateUrl: './torrent-picker.component.html',
  styleUrls: ['./torrent-picker.component.scss']
})
export class TorrentPickerComponent implements OnInit , OnDestroy {

  request:TorrentPickRequest;
  private previousFocus:HTMLElement;
  private subscriptions:Subscription[] = [];
  private focusListener;

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

    this.focusListener = (e) => {
      let node = e.target as HTMLElement;
      if (node.classList.contains('torrentOption')) this.scrollIntoList(node);
    };
    window.addEventListener('sn:focused', this.focusListener);
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach(s => s.unsubscribe());
    window.removeEventListener('sn:focused', this.focusListener);
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
      this.navigation.updateNavigation('add' , {
        id: 'torrentPicker',
        selector: '.torrentPicker .torrentOption',
        restrict : 'self-only',
        straightOnly: true,
      });
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
    this.navigation.updateNavigation('remove' , {sectionId : 'torrentPicker'});
    this.previousFocus?.focus({preventScroll : true});
    done();
    this.request = undefined;
    this.picker.isOpen = false;
  }

  // Keep the focused option inside the (natively scrolling) list
  scrollIntoList(node:HTMLElement){
    let list = node.closest('.options') as HTMLElement;
    let listRect = list.getBoundingClientRect();
    let rect = node.getBoundingClientRect();
    let top = list.scrollTop;
    if (rect.top < listRect.top) top -= listRect.top - rect.top;
    else if (rect.bottom > listRect.bottom) top += rect.bottom - listRect.bottom;
    list.scrollTo({ top , behavior : 'smooth' });
  }
}
