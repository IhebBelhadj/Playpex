import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import type { Schema } from '@playpex/protocol';
import type { PlaySource, PlaySources } from './play-sources.service';
import { formatBytes } from './torrent-picker.service';

export type PlayGroupName = Schema<'PlayGroupName'>;

// One way to play, as the chooser words it
export interface ChooserLine {
  source:PlaySource;
  quality:string;          // "1080p"
  detail:string;           // "x265 · AAC · 1.9 GB · 312 seeds"
  ready:string;            // "Plays now" / "Starts in seconds" / … ('' when `caution` says why it may not play)
  caution:string;          // "HEVC: may not play"
  progress:number | null;  // a download still running: how much is there
  name:string;             // the release / file name (the full list shows it)
}

// A group of the chooser: its best line(s), and the rest one step further
export interface ChooserLane {
  group:PlayGroupName;
  name:string;             // "On this server" / "Stream" / "Torrent"
  lines:ChooserLine[];     // the best, and a second one of another quality that plays
  all:ChooserLine[];
  more:string | null;      // "All 41 torrents", when there are more than shown
}

export interface ChooserRequest {
  title:string;
  kind:'play' | 'download';
  lanes:ChooserLane[];
  footnotes:string[];      // not choices: what a plugin hid, sources that didn't answer
  pick:(source:PlaySource) => void;
  cancel:() => void;
}

const LANE_NAMES:Record<PlayGroupName, string> = { server: 'On this server', stream: 'Stream', torrent: 'Torrent' };
const NOUNS:Record<PlayGroupName, [string, string]> = { server: ['file', 'files'], stream: ['stream', 'streams'], torrent: ['torrent', 'torrents'] };
const READY:Record<string, string> = {
  instant: 'Plays now',
  seconds: 'Starts in seconds',
  slow: 'Few people sharing: may be slow',
  unknown: '',
};
const ORDER:PlayGroupName[] = ['server', 'stream', 'torrent'];
// the usual video codec isn't worth saying; the server's audio verdicts aren't names
const PLAIN_CODECS = ['h264', 'x264', 'avc'];
const AUDIO_VERDICTS = ['supported', 'unsupported', 'unknown'];

// The Play chooser (docs/providers-plan.md §5.2, §10.2): the ways to play a
// title grouped by kind (on this server, stream, torrent), each kind's best
// first, the full list one step further. choose() emits the picked source
// once, or completes without a value on Back. Drawn by <play-chooser>.
@Injectable({
  providedIn: 'root'
})
export class PlayChooserService {

  private requests = new Subject<ChooserRequest>();

  choose(title:string, result:PlaySources, options:{ kind?:'play' | 'download', only?:PlayGroupName[], footnotes?:string[] } = {}):Observable<PlaySource> {
    return new Observable(subscriber => {
      this.requests.next({
        title,
        kind: options.kind || 'play',
        lanes: PlayChooserService.lanes(result, options.only),
        footnotes: options.footnotes || [],
        pick: source => { subscriber.next(source); subscriber.complete(); },
        cancel: () => subscriber.complete(),
      });
    });
  }

  onRequest():Observable<ChooserRequest> {
    return this.requests.asObservable();
  }

  // A source's group: the server's word for it, else from its type (an older server)
  static groupOf(source:PlaySource):PlayGroupName {
    if (source.group) return source.group;
    return source.type == 'file' || source.type == 'download' ? 'server' :
      source.type == 'plugin' || source.resolver ? 'stream' : 'torrent';
  }

  static lanes(result:PlaySources, only?:PlayGroupName[]):ChooserLane[] {
    let order = (result.groups?.length ? result.groups.map(g => g.group) : ORDER)
      .filter(g => !only || only.includes(g));
    return order.map(group => {
      let sources = result.sources.filter(s => PlayChooserService.groupOf(s) == group);
      if (!sources.length) return null;
      let all = sources.map(s => PlayChooserService.line(s));
      let lines = [all[0]];
      let other = all.find(l => l.quality != all[0].quality && !l.caution);
      if (other) lines.push(other);
      let [one, many] = NOUNS[group];
      return {
        group,
        name: LANE_NAMES[group],
        lines,
        all,
        more: all.length > lines.length ? `All ${all.length} ${all.length == 1 ? one : many}` : null,
      };
    }).filter(Boolean);
  }

  static line(source:PlaySource):ChooserLine {
    let group = PlayChooserService.groupOf(source);
    let downloading = source.type == 'download' && (source.progress ?? 1) < 1;
    let caution = source.playable == 'no' ? (source.notes[0] || "Won't play here") :
      source.playable == 'maybe' ? (source.notes[0] || 'May not play here') : '';
    let codec = source.codec && !PLAIN_CODECS.includes(source.codec) ? (source.codec == 'hevc' ? 'x265' : source.codec) : null;
    let audio = source.audio && !AUDIO_VERDICTS.includes(source.audio) ? source.audio : null;
    let detail:string[] = [];
    if (group == 'server') {
      detail.push(downloading ? `Downloading ${Math.floor((source.progress || 0) * 100)} %` : source.type == 'download' ? 'Downloaded' : 'In the library');
      if (codec) detail.push(codec);
      if (source.badges.includes('hdr')) detail.push('HDR');
      if (source.playable == 'audio-converted') detail.push('sound converted');
    } else if (group == 'stream') {
      detail.push(source.resolver ? `from ${source.resolver.label}` : source.label);
      if (codec) detail.push(codec);
    } else {
      if (codec) detail.push(codec);
      if (audio) detail.push(audio);
      if (source.size) detail.push(formatBytes(source.size));
      if (source.seeds != null) detail.push(`${source.seeds} seeds`);
      if (source.badges.includes('pack')) detail.push('season pack');
    }
    return {
      source,
      quality: source.quality || 'Video',
      detail: detail.filter(Boolean).join(' · '),
      ready: caution ? '' : READY[source.readiness || PlayChooserService.readinessOf(source)] || '',
      caution,
      progress: downloading ? source.progress || 0 : null,
      name: source.label,
    };
  }

  // An older server sends no readiness: the same rule as the server's
  static readinessOf(source:PlaySource):string {
    if (source.type == 'file' || (source.type == 'download' && source.progress === 1) || source.type == 'plugin' || source.resolver) return 'instant';
    if (source.type == 'download') return source.state == 'downloading' ? 'seconds' : 'unknown';
    if (source.seeds == null) return 'unknown';
    return source.seeds >= 10 ? 'seconds' : 'slow';
  }
}
