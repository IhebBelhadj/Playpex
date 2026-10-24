import { PlayChooserService } from './play-chooser.service';
import type { PlaySource, PlaySources } from './play-sources.service';

function source(id:string, type:PlaySource['type'], extra:Partial<PlaySource> = {}):PlaySource {
  return { id, type, provider: type, label: id + '.mkv', playable: 'yes', badges: [], notes: [], ...extra } as PlaySource;
}

function answer(sources:PlaySource[], groups?:PlaySources['groups']):PlaySources {
  return { request: 'r', sources, groups, hidden: [], policy: { autoplay: null }, errors: [] } as PlaySources;
}

describe('PlayChooserService', () => {
  const file = source('f_1', 'file', { quality: '2160p', group: 'server', readiness: 'instant', badges: ['hdr'], codec: 'hevc' });
  const file2 = source('f_2', 'file', { quality: '1080p', group: 'server', readiness: 'instant' });
  const stream = source('r_1', 'plugin', { quality: '1080p', group: 'stream', readiness: 'instant', label: 'Heat 1080p WEB' });
  const t1 = source('torrent:a', 'torrent', { quality: '1080p', seeds: 312, size: 1.9e9, audio: 'AAC', group: 'torrent', readiness: 'seconds' });
  const t2 = source('torrent:b', 'torrent', { quality: '1080p', seeds: 4, group: 'torrent', readiness: 'slow' });
  const t3 = source('torrent:c', 'torrent', { quality: '2160p', seeds: 50, playable: 'maybe', notes: ['May not play (x265 / 10-bit / 4K)'], group: 'torrent', readiness: 'seconds' });

  it('makes one lane per group in the server\'s order, best first, a second line of another quality, the rest behind "All N"', () => {
    let lanes = PlayChooserService.lanes(answer([file, stream, t1, t2, t3, file2], [
      { group: 'server', best: 'f_1', count: 2, readiness: 'instant' },
      { group: 'stream', best: 'r_1', count: 1, readiness: 'instant' },
      { group: 'torrent', best: 'torrent:a', count: 3, readiness: 'seconds' },
    ]));
    expect(lanes.map(l => l.name)).toEqual(['On this server', 'Stream', 'Torrent']);
    expect(lanes[0].lines.map(l => l.source.id)).toEqual(['f_1', 'f_2']);
    expect(lanes[0].more).toBeNull();
    expect(lanes[1].more).toBeNull();
    // the 2160p torrent may not play: not the second line
    expect(lanes[2].lines.map(l => l.source.id)).toEqual(['torrent:a']);
    expect(lanes[2].more).toBe('All 3 torrents');
    expect(lanes[2].all.length).toBe(3);
  });

  it('keeps only the groups asked for (Download: torrents)', () => {
    let lanes = PlayChooserService.lanes(answer([file, stream, t1]), ['torrent']);
    expect(lanes.map(l => l.group)).toEqual(['torrent']);
  });

  it('groups sources by type when an older server sends no groups', () => {
    let old = [source('f_9', 'file'), source('torrent:z', 'torrent', { seeds: 20 }), source('torrent:y', 'torrent', { resolver: { plugin: 'd', label: 'Debrid' } })];
    let lanes = PlayChooserService.lanes(answer(old));
    expect(lanes.map(l => [l.group, l.all.length])).toEqual([['server', 1], ['stream', 1], ['torrent', 1]]);
    expect(lanes[2].lines[0].ready).toBe('Starts in seconds');
  });

  it('words each line: what it is, and how soon it plays or why it may not', () => {
    let plain = source('torrent:p', 'torrent', { quality: '720p', codec: 'x264', audio: 'supported', seeds: 4, size: 9e8 });
    expect(PlayChooserService.line(plain).detail).toBe('900 MB · 4 seeds');
    expect(PlayChooserService.line(file)).toEqual(jasmine.objectContaining({ quality: '2160p', detail: 'In the library · x265 · HDR', ready: 'Plays now', caution: '' }));
    expect(PlayChooserService.line(t1).detail).toBe('AAC · 1.9 GB · 312 seeds');
    expect(PlayChooserService.line(t2).ready).toBe('Few people sharing: may be slow');
    expect(PlayChooserService.line(t3)).toEqual(jasmine.objectContaining({ ready: '', caution: 'May not play (x265 / 10-bit / 4K)' }));
    let cached = source('torrent:d', 'torrent', { resolver: { plugin: 'd', label: 'Real-Debrid' }, group: 'stream', readiness: 'instant' });
    expect(PlayChooserService.line(cached).detail).toBe('from Real-Debrid');
    let half = source('t_x_1', 'download', { progress: 0.43, state: 'downloading' });
    expect(PlayChooserService.line(half)).toEqual(jasmine.objectContaining({ detail: 'Downloading 43 %', progress: 0.43, ready: 'Starts in seconds' }));
  });
});
