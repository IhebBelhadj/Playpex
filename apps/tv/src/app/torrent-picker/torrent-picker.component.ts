import { Component, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { Subscription } from 'rxjs';
import { TorrentOption, TorrentPickRequest, TorrentPickerService } from '../torrent-picker.service';
import { PxDialogComponent } from '../ui/public-api';

// Modal list of torrents shown before playback (movies and episodes), on the
// <px-dialog> frame (a layer of the nav system while open: Back cancels, the
// focus goes back where it was; the list scrolls natively).
@Component({
  selector: 'torrent-picker',
  templateUrl: './torrent-picker.component.html',
  styleUrls: ['./torrent-picker.component.scss']
})
export class TorrentPickerComponent implements OnInit , OnDestroy {

  request:TorrentPickRequest;
  @ViewChild(PxDialogComponent) dialog:PxDialogComponent;
  private subscription:Subscription;

  constructor(private picker:TorrentPickerService) { }

  ngOnInit(): void {
    this.subscription = this.picker.onRequest().subscribe(request => this.open(request));
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
    this.cancel();
  }

  open(request:TorrentPickRequest){
    // a new request while one is open takes its place (same layer)
    this.request?.cancel();
    let reopened = !!this.request;
    this.request = request;
    if (reopened) setTimeout(() => this.dialog?.reset(), 0);
  }

  pick(option:TorrentOption){
    let request = this.request;
    this.request = undefined;
    this.dialog?.finish();
    request?.pick(option);
  }

  cancel(){
    let request = this.request;
    this.request = undefined;
    request?.cancel();
  }

}
