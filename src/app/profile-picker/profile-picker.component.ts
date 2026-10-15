import { AfterViewInit, Component, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { gsap, Power2 } from 'gsap';
import { NavigationService } from '../navigation.service';
import { MenuServiceService } from '../menu-service.service';
import { SplashService } from '../splash.service';
import { NotificationService } from '../notification.service';
import { Profile, ProfilesService } from '../profiles.service';
import { PinPadComponent } from '../pin-pad/pin-pad.component';

// "Who's watching?" — the app's start page. Enter on a profile selects it
// (asking for the PIN when it has one) and opens the movies; "Manage Profiles"
// switches the tiles to edit mode (→ /profiles/:id/edit); "Add Profile" → /profiles/new.
// Back: leaves manage mode, otherwise opens /power.
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

  private navSub:Subscription;
  private splashSub:Subscription;
  private focusListener;
  private entering = false;

  constructor(
    private profilesService:ProfilesService,
    private navigation:NavigationService,
    private menuService:MenuServiceService,
    private splashService:SplashService,
    private notification:NotificationService,
    private router:Router,
  ) { }

  ngOnInit(): void {
    this.managing = this.profilesService.picker.managing;
    setTimeout(() => this.menuService.sendInstruction('hide', this), 0);
    this.load();
  }

  ngAfterViewInit(): void {
    this.navigation.updateNavigation('add', {
      id: 'profiles',
      selector: '.profilesPage .focusable',
      restrict: 'self-only',
    });

    this.navSub = this.navigation.executeCommand().subscribe(instruction => {
      // the PIN pad handles its own keys while it is open
      if (this.router.url != '/profiles' || this.pinProfile || this.entering) return;
      if (!this.splashService.cleared) return;

      let active = document.activeElement as HTMLElement;
      if (instruction == 'click') {
        if (active.classList.contains('retryBtn')) this.load();
        else if (active.classList.contains('manageBtn')) this.toggleManage();
        else if (active.classList.contains('profileTile')) this.choose(active.dataset['id']);
      }
      if (instruction == 'back') {
        if (this.managing) this.toggleManage();
        else this.router.navigateByUrl('/power');
      }
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
    this.navSub?.unsubscribe();
    this.splashSub?.unsubscribe();
    window.removeEventListener('sn:focused', this.focusListener);
    this.navigation.updateNavigation('remove', { sectionId: 'profiles' });
    this.menuService.sendInstruction('show', this);
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
        setTimeout(() => (document.querySelector('.profilesPage .retryBtn') as HTMLElement)?.focus({ preventScroll: true }), 0);
      }
    });
  }

  toggleManage() {
    this.managing = !this.managing;
    this.profilesService.picker.managing = this.managing;
  }

  choose(id:string) {
    if (id == 'new') {
      this.router.navigateByUrl('/profiles/new');
      return;
    }
    if (this.managing) {
      this.router.navigateByUrl(`/profiles/${id}/edit`);
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
            this.router.navigateByUrl('/movies/list');
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
