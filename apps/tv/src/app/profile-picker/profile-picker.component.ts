import { AfterViewInit, Component, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { Subscription } from 'rxjs';
import { gsap, Power2 } from 'gsap';
import { SplashService } from '../splash.service';
import { NotificationService } from '../notification.service';
import { Profile, ProfilesService } from '../profiles.service';
import { PinPadComponent } from '../pin-pad/pin-pad.component';
import { Navigator, useScreen } from '../nav/public-api';

// "Who's watching?" — the app's start page. Enter on a profile selects it
// (asking for the PIN when it has one) and opens the movies; "Manage Profiles"
// switches the tiles to edit mode (→ the editor); "Add Profile" → a new one.
// A root screen (core.profiles, src/app/nav): choosing a profile starts the
// history over on the movies. Back: leaves manage mode, otherwise opens the
// power menu (the root's back policy).
@Component({
  selector: 'app-profile-picker',
  templateUrl: './profile-picker.component.html',
  styleUrls: ['./profile-picker.component.scss']
})
export class ProfilePickerComponent implements OnInit, AfterViewInit, OnDestroy {

  profiles:Profile[] = [];
  maxProfiles = 8;
  loaded = false;
  loadError = '';
  managing = false;
  pinProfile:Profile | null = null;

  @ViewChild(PinPadComponent) pinPad:PinPadComponent;

  private splashSub:Subscription;
  private focusListener;
  private entering = false;
  private screen = useScreen();

  constructor(
    private profilesService:ProfilesService,
    private navigator:Navigator,
    private splashService:SplashService,
    private notification:NotificationService,
  ) { }

  ngOnInit(): void {
    this.managing = this.profilesService.picker.managing;
    this.load();
  }

  // Section `profiles` is a pxSection in the template (tiles: a pxGrid)
  ngAfterViewInit(): void {

    // (the PIN pad is a layer: it takes the keys while it's open)
    this.screen.onSelect(active => {
      if (this.entering || !this.splashService.cleared) return;
      if (active.classList.contains('profileTile')) this.choose(active.dataset['id']);
    });
    this.screen.onBack(() => {
      if (this.entering || !this.splashService.cleared) return true;
      if (!this.managing) return false;
      this.toggleManage();
      return true;
    });

    // Remember the focused tile for the next visit (back from the editor / player)
    this.focusListener = (e) => {
      let node = e.target as HTMLElement;
      if (node.classList.contains('profileTile') && node.dataset['id'] != 'new') {
        this.profilesService.picker.focusId = node.dataset['id'];
      }
    };
    window.addEventListener('sn:focused', this.focusListener);

    // Started under the splash video: focus again once it is gone
    if (!this.splashService.cleared) {
      this.splashSub = this.splashService.splashExecuteCommand().subscribe(instruction => {
        if (instruction == 'clearSplash') this.focusTile(this.profilesService.picker.focusId);
      });
    }
  }

  ngOnDestroy(): void {
    this.splashSub?.unsubscribe();
    window.removeEventListener('sn:focused', this.focusListener);
  }

  load() {
    this.loadError = '';
    this.profilesService.list().subscribe({
      next: data => {
        this.profiles = data.profiles;
        this.maxProfiles = data.maxProfiles;
        this.loaded = true;
        let focusId = this.profilesService.picker.focusId;
        if (!this.profiles.some(p => p.id == focusId)) focusId = data.lastUsedId;
        this.focusTile(focusId);
      },
      error: err => {
        this.loaded = true;
        this.loadError = ProfilesService.errorMessage(err);
        setTimeout(() => (document.querySelector('.profilesPage [data-px-key="retry"]') as HTMLElement)?.focus({ preventScroll: true }), 0);
      }
    });
  }

  toggleManage() {
    this.managing = !this.managing;
    this.profilesService.picker.managing = this.managing;
  }

  choose(id:string) {
    if (id == 'new') {
      this.navigator.open({ screen: 'core.profiles.new' });
      return;
    }
    if (this.managing) {
      this.navigator.open({ screen: 'core.profiles.edit', params: { id } });
      return;
    }
    let profile = this.profiles.find(p => p.id == id);
    if (!profile) return;
    if (profile.hasPin) this.pinProfile = profile;
    else this.enter(profile);
  }

  onPinCompleted(pin:string) {
    this.enter(this.pinProfile, pin);
  }

  onPinCancelled() {
    let id = this.pinProfile?.id;
    this.pinProfile = null;
    this.focusTile(id);
  }

  avatarUrl(avatar:string | null) {
    return ProfilesService.avatarUrl(avatar);
  }

  private enter(profile:Profile, pin?:string) {
    this.entering = true;
    this.profilesService.unlock(profile.id, pin).subscribe({
      next: p => {
        this.profilesService.picker.focusId = p.id;
        this.profilesService.picker.managing = false;
        gsap.to('.profilesPage', {
          opacity: 0, scale: 1.08, duration: .35, ease: Power2.easeIn,
          onComplete: () => {
            this.pinProfile = null;
            this.navigator.reset({ screen: 'core.movies' });
          }
        });
      },
      error: err => {
        this.entering = false;
        if (this.pinProfile && this.pinPad) this.pinPad.fail(ProfilesService.errorMessage(err));
        else this.notification.sendNotification('error', ProfilesService.errorMessage(err));
      }
    });
  }

  private focusTile(id:string | null) {
    setTimeout(() => {
      let tile = (id && document.querySelector(`.profilesPage .profileTile[data-id="${id}"]`))
        || document.querySelector('.profilesPage .profileTile');
      (tile as HTMLElement)?.focus({ preventScroll: true });
    }, 0);
  }
}
