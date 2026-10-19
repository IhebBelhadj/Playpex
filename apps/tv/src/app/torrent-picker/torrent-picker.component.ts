import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { NavigationService } from '../navigation.service';
import { TorrentOption, TorrentPickRequest, TorrentPickerService } from '../torrent-picker.service';
import { LayerRef, LayerStack, LAYER_PRIORITY } from '../nav/public-api';

// Modal list of torrents shown before playback (movies and episodes).
// Own trapping section (pxSection) over a scrolling list (pxGrid); a layer
// of the nav system while open (src/app/nav): it gets select / back, Back
// cancels, the focus goes back where it was.
@Component({
  selector: 'torrent-picker',
  templateUrl: './torrent-picker.component.html',
  styleUrls: ['./torrent-picker.component.scss']
})
export class TorrentPickerComponent implements OnInit , OnDestroy {

  request:TorrentPickRequest;
  private layer:LayerRef<TorrentOption> | null = null;
  private subscription:Subscription;

  constructor(
    private picker:TorrentPickerService,
    private navigation:NavigationService,
    private layers:LayerStack,
  ) { }

  ngOnInit(): void {
    this.subscription = this.picker.onRequest().subscribe(request => this.open(request));
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
    this.layer?.close();
  }

  open(request:TorrentPickRequest){
    this.layer?.close(undefined, false);
    this.request = request;
    let layer = this.layer = this.layers.open<TorrentOption>({
      id: 'torrentPicker',
      priority: LAYER_PRIORITY.modal,
      element: () => document.querySelector('.torrentPicker'),
    });
    layer.result$.subscribe({
      next: option => request.pick(option),
      complete: () => {
        request.cancel();
        if (this.layer !== layer) return;
        this.layer = null;
        this.request = undefined;
      },
    });

    // wait for the options to render
    setTimeout(() => {
      let list = document.querySelector('.torrentPicker .options') as HTMLElement;
      if (list) list.scrollTop = 0;
      this.navigation.updateNavigation('focus' , {sectionId : 'torrentPicker'});
    } , 0);
  }

  pick(option:TorrentOption){
    this.layer?.close(option);
  }

}
