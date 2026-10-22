import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { BehaviorSubject, Subject } from 'rxjs';
import { ProfilesService } from './profiles.service';
import { ServerEvents } from './server-events.service';
import { ServerService } from './server.service';
import { SettingsService } from './settings.service';
import { display, Toasts } from './ui/public-api';

// SettingsService against a fake server (docs/settings-plan.md §7)
describe('SettingsService', () => {

  const API = 'http://server/api/v1';
  let http:HttpTestingController;
  let settings:SettingsService;
  let current:BehaviorSubject<any>;
  let events:Subject<any>;
  let toasts:jasmine.SpyObj<Toasts>;

  const deviceAnswer = (over:any = {}) => ({ 'display.uiScale': 0.8, 'display.safeArea': 0, 'player.volume': 100, 'subtitles.size': 'medium', ...over });
  const profileAnswer = (over:any = {}) => ({ 'subtitles.provider': null, 'player.autoplayNext': true, 'adult.layout': 'posters', 'adult.metadataProvider': null, ...over });

  function answerLoad(profileId:string | null, device:any = {}, profile:any = {}) {
    let req = http.expectOne(r => r.url == `${API}/settings` && (r.params.get('profile') || null) == profileId);
    expect(req.request.params.get('device')).toBe('dev-1');
    req.flush({ device: deviceAnswer(device), profile: profileId ? profileAnswer(profile) : null });
  }

  beforeEach(() => {
    current = new BehaviorSubject<any>(null);
    events = new Subject();
    toasts = jasmine.createSpyObj('Toasts', ['show']);
    try { ['playpex.subtitleSize', 'playpex.volumePercent', 'playpex.subtitleProvider'].forEach(k => localStorage.removeItem(k)); } catch (e) { }
    display.chosen = true;
    display.scale = 0.8;
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        { provide: ServerService, useValue: { connected: true, api: API, deviceId: 'dev-1', deviceParams: () => ({ device: 'dev-1' }) } },
        { provide: ProfilesService, useValue: { current } },
        { provide: ServerEvents, useValue: { on: () => events } },
        { provide: Toasts, useValue: toasts },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    settings = TestBed.inject(SettingsService);
  });

  afterEach(() => http.verify());

  it('has the registry defaults before the server answers, then the server values', () => {
    expect(settings.value('player.volume')).toBe(100);
    expect(settings.loaded$.value).toBeFalse();
    answerLoad(null, { 'player.volume': 40 });
    expect(settings.value('player.volume')).toBe(40);
    expect(settings.loaded$.value).toBeTrue();
  });

  it('reads again when the profile changes, with that profile', () => {
    answerLoad(null);
    current.next({ id: 'p1' });
    answerLoad('p1', {}, { 'subtitles.provider': 'yify' });
    expect(settings.value('subtitles.provider')).toBe('yify');
    // the same profile again (a profile update): no new read
    current.next({ id: 'p1', name: 'renamed' });
    http.expectNone(`${API}/settings`);
  });

  it('applies a value at once and writes it to its scope', () => {
    answerLoad(null);
    current.next({ id: 'p1' });
    answerLoad('p1');
    let seen:any[] = [];
    settings.changes('subtitles.provider').subscribe(v => seen.push(v));
    settings.set('subtitles.provider', 'yify');
    expect(seen).toEqual([null, 'yify']);
    let req = http.expectOne(`${API}/profiles/p1/settings?device=dev-1`);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ 'subtitles.provider': 'yify' });
    req.flush(profileAnswer({ 'subtitles.provider': 'yify' }));

    settings.set('player.volume', 30);
    let device = http.expectOne(`${API}/settings/device?device=dev-1`);
    expect(device.request.body).toEqual({ 'player.volume': 30 });
    device.flush(deviceAnswer({ 'player.volume': 30 }));
  });

  it('puts the previous value back and shows a toast when the server refuses', () => {
    answerLoad(null);
    settings.set('player.volume', 30);
    http.expectOne(`${API}/settings/device?device=dev-1`).flush({ error: 'nope', code: 'INVALID' }, { status: 400, statusText: 'Bad' });
    expect(settings.value('player.volume')).toBe(100);
    expect(toasts.show).toHaveBeenCalledWith(jasmine.objectContaining({ tone: 'error' }));
  });

  it('writes a slider once it stops moving', fakeAsync(() => {
    answerLoad(null);
    settings.set('player.volume', 90, { debounceMs: 500 });
    tick(200);
    settings.set('player.volume', 80, { debounceMs: 500 });
    tick(200);
    settings.set('player.volume', 70, { debounceMs: 500 });
    expect(settings.value('player.volume')).toBe(70);
    http.expectNone(`${API}/settings/device?device=dev-1`);
    tick(500);
    let req = http.expectOne(`${API}/settings/device?device=dev-1`);
    expect(req.request.body).toEqual({ 'player.volume': 70 });
    // refused: back to the value before the whole run, not 80
    req.flush({}, { status: 500, statusText: 'x' });
    expect(settings.value('player.volume')).toBe(100);
  }));

  it('refuses values the registry refuses, without a request', () => {
    answerLoad(null);
    spyOn(console, 'error');
    settings.set('player.volume', 1000 as any);
    expect(settings.value('player.volume')).toBe(100);
    http.expectNone(`${API}/settings/device?device=dev-1`);
  });

  it('reads again on settings.changed for this device or profile, not for others', () => {
    answerLoad(null);
    current.next({ id: 'p1' });
    answerLoad('p1');
    events.next({ topic: 'settings.changed', data: { scope: 'device', ownerId: 'other', keys: ['player.volume'] } });
    events.next({ topic: 'settings.changed', data: { scope: 'profile', ownerId: 'p2', keys: ['adult.layout'] } });
    http.expectNone(`${API}/settings`);
    events.next({ topic: 'settings.changed', data: { scope: 'profile', ownerId: 'p1', keys: ['adult.layout'] } });
    answerLoad('p1', {}, { 'adult.layout': 'compact' });
    expect(settings.value('adult.layout')).toBe('compact');
  });

  it('moves values kept in localStorage to the server once', () => {
    localStorage.setItem('playpex.volumePercent', '35');
    localStorage.setItem('playpex.subtitleProvider', 'yify');
    answerLoad(null);
    let req = http.expectOne(`${API}/settings/device?device=dev-1`);
    expect(req.request.body).toEqual({ 'player.volume': 35 });
    req.flush(deviceAnswer({ 'player.volume': 35 }));
    expect(localStorage.getItem('playpex.volumePercent')).toBeNull();
    // a profile key waits for a profile
    expect(localStorage.getItem('playpex.subtitleProvider')).toBe('yify');
    current.next({ id: 'p1' });
    answerLoad('p1');
    http.expectOne(`${API}/profiles/p1/settings?device=dev-1`).flush(profileAnswer({ 'subtitles.provider': 'yify' }));
    expect(localStorage.getItem('playpex.subtitleProvider')).toBeNull();
  });

  it('pushes this device\'s UI size when the server has none yet', () => {
    display.scale = 1;
    answerLoad(null);
    let req = http.expectOne(`${API}/settings/device?device=dev-1`);
    expect(req.request.body).toEqual({ 'display.uiScale': 1 });
    req.flush(deviceAnswer({ 'display.uiScale': 1 }));
  });
});
