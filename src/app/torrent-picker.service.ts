import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { InputAction } from './keymap';

// One choice in the picker, normalized from YTS (movies) or the server's
// episode search (EZTV / TheRARBG)
export interface TorrentOption {
  quality: string;          // "1080p"
  tags: string[];           // "x265", "BluRay", "Season pack", …
  size?: string;            // "1.4 GB"
  seeds?: number;
  peers?: number;
  name?: string;            // release name, when the provider has one
  warnings: string[];       // e.g. "May not play", "Probably no sound"
  recommended?: boolean;
  torrent: any;             // the provider's torrent object, handed back on pick
}

export interface TorrentPickRequest {
  title: string;
  options: TorrentOption[];
  pick: (option:TorrentOption) => void;
  cancel: () => void;
}

// "Choose a torrent" modal. choose() emits the picked option once, or
// completes without a value when the user backs out.
@Injectable({
  providedIn: 'root'
})
export class TorrentPickerService {

  isOpen = false;
  private requests = new Subject<TorrentPickRequest>();
  private commands = new Subject<InputAction>();

  choose(title:string , options:TorrentOption[]): Observable<TorrentOption> {
    return new Observable(subscriber => {
      this.requests.next({
        title,
        options,
        pick : option => { subscriber.next(option); subscriber.complete(); },
        cancel : () => subscriber.complete(),
      });
    });
  }

  onRequest(): Observable<TorrentPickRequest> {
    return this.requests.asObservable();
  }

  // While the picker is open it receives select/back instead of the pages
  sendCommand(action:InputAction){
    this.commands.next(action);
  }

  onCommand(): Observable<InputAction> {
    return this.commands.asObservable();
  }

  // YTS torrent: {hash, quality, type, video_codec, bit_depth, audio_channels, seeds, peers, size}
  static fromYts(torrent): TorrentOption {
    let hevc = /x265|hevc/i.test(torrent['video_codec'] || '');
    let tenBit = torrent['bit_depth'] == '10';
    let tags = [
      torrent['type'] ? capitalize(torrent['type']) : null,
      torrent['video_codec'],
      tenBit ? '10-bit' : null,
      torrent['audio_channels'] ? torrent['audio_channels'] + ' ch' : null,
    ].filter(Boolean);

    return {
      quality : torrent['quality'],
      tags,
      size : torrent['size'],
      seeds : torrent['seeds'],
      peers : torrent['peers'],
      warnings : (hevc || tenBit || torrent['quality'] == '2160p') ? ['May not play (x265 / 10-bit / 4K)'] : [],
      torrent,
    };
  }

  // Server episode torrent (lib/episodes.js): {name, quality, codec, audio, playable, pack, seeds, size, magnet};
  // 18+ movie torrents (lib/adult.js) have the same shape, plus `scenes`
  static fromEpisode(torrent , index:number): TorrentOption {
    let warnings = [];
    if (!torrent['playable']) warnings.push('May not play (x265 / 10-bit / 4K)');
    if (torrent['audio'] == 'unsupported') warnings.push('Probably no sound (Dolby / DTS audio)');

    return {
      quality : torrent['quality'],
      tags : [
        torrent['codec'],
        torrent['pack'] ? 'Season pack' : null,
        torrent['scenes'] ? 'Split scenes' : null,
      ].filter(Boolean),
      size : torrent['size'] ? formatBytes(torrent['size']) : undefined,
      seeds : torrent['seeds'],
      name : torrent['name'],
      warnings,
      recommended : index == 0,     // the server ranks them best first
      torrent,
    };
  }
}

function capitalize(text:string){
  return text.length <= 3 ? text.toUpperCase() : text[0].toUpperCase() + text.slice(1);
}

function formatBytes(bytes:number){
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  return Math.round(bytes / 1e6) + ' MB';
}
