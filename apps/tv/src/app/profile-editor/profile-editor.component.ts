import { AfterViewInit, Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { concatMap, Observable, of, Subscription } from 'rxjs';
import { NavigationService } from '../navigation.service';
import { MenuServiceService } from '../menu-service.service';
import { NotificationService } from '../notification.service';
import { AVATARS, Profile, ProfilesService } from '../profiles.service';

type Panel = null | 'keyboard' | 'avatars' | 'pin' | 'confirmDelete';

// Overlay panels and their navigation sections (restrict self-only while open).
// The name keyboard (<text-keyboard>) and the PIN pad own their sections.
const NAME_MAX = 30;

// /profiles/new and /profiles/:id/edit. Changes are kept locally and sent on
// Save (profile fields, then the PIN if it changed). Back closes the open panel,
// otherwise cancels.
@Component({
  selector: 'app-profile-editor',
  templateUrl: './profile-editor.component.html',
  styleUrls: ['./profile-editor.component.scss']
})
export class ProfileEditorComponent implements OnInit, AfterViewInit, OnDestroy {

  id:string | null = null;
  ready = false;
  name = '';
  avatar = AVATARS[0];
  isKid = false;
  hasPin = false;
  // undefined = unchanged, null = remove the lock, '1234' = new PIN
  pendingPin:string | null | undefined = undefined;
  error = '';
  saving = false;

  panel:Panel = null;
  avatars = AVATARS;
  nameMax = NAME_MAX;

  private navSub:Subscription;
  private returnFocus:string | null = null;

  constructor(
    private profilesService:ProfilesService,
    private navigation:NavigationService,
    private menuService:MenuServiceService,
    private notification:NotificationService,
    private route:ActivatedRoute,
    private router:Router,
  ) { }

  get pinActive():boolean {
    return this.pendingPin === undefined ? this.hasPin : this.pendingPin !== null;
  }

  ngOnInit(): void {
    setTimeout(() => this.menuService.sendInstruction('hide', this), 0);
    this.id = this.route.snapshot.paramMap.get('id');

    if (this.id) {
      this.profilesService.get(this.id).subscribe({
        next: p => this.fill(p),
        error: err => {
          this.notification.sendNotification('error', ProfilesService.errorMessage(err));
          this.router.navigateByUrl('/profiles');
        }
      });
    } else {
      // New profile: first avatar nobody uses yet
      this.profilesService.list().subscribe({
        next: data => {
          let used = data.profiles.map(p => p.avatar);
          this.avatar = AVATARS.find(a => !used.includes(a)) || AVATARS[0];
          this.show('name');
        },
        error: () => this.show('name'),
      });
    }
  }

  // Sections `profileEditor`, `avatarChooser` and `confirmDelete` are
  // pxSection directives in the template (the panels' are traps)
  ngAfterViewInit(): void {

    this.navSub = this.navigation.executeCommand().subscribe(instruction => {
      if (!this.router.url.startsWith('/profiles/') || this.saving) return;
      // the PIN pad and the keyboard handle their own keys
      if (this.panel == 'pin' || this.panel == 'keyboard') return;

      if (instruction == 'back' || instruction == 'leave') {
        if (this.panel) this.closePanel();
        else this.cancel();
        return;
      }
      if (instruction != 'click') return;

      let active = document.activeElement as HTMLElement;
      let data = active.dataset;
      if (this.panel == 'avatars' && data['avatar']) this.chooseAvatar(data['avatar']);
      else if (this.panel == 'confirmDelete' && data['confirm']) data['confirm'] == 'yes' ? this.remove() : this.closePanel();
      else if (!this.panel && data['field']) this.activateField(data['field']);
      else if (!this.panel && data['action']) this.activateAction(data['action']);
    });
  }

  ngOnDestroy(): void {
    this.navSub?.unsubscribe();
    this.menuService.sendInstruction('show', this);
  }

  avatarUrl(avatar:string | null) {
    return ProfilesService.avatarUrl(avatar);
  }

  // ── fields ────────────────────────────────────────────────────────────────

  private activateField(field:string) {
    switch (field) {
      case 'avatar':
        this.openPanel('avatars', 'avatar', `.avatarPanel [data-avatar="${this.avatar}"]`);
        break;
      case 'name':
        this.returnFocus = 'name';
        this.panel = 'keyboard';
        break;
      case 'kid':
        this.isKid = !this.isKid;
        break;
      case 'pin':
        this.returnFocus = 'pin';
        this.panel = 'pin';
        break;
      case 'removePin':
        this.pendingPin = null;
        this.show('pin');
        break;
    }
  }

  private activateAction(action:string) {
    if (action == 'save') this.save();
    else if (action == 'cancel') this.cancel();
    else if (action == 'delete') this.openPanel('confirmDelete', null, '.confirmPanel [data-confirm="no"]');
  }

  // ── panels ────────────────────────────────────────────────────────────────

  private openPanel(panel:'avatars' | 'confirmDelete', returnFocus:string | null, focusSelector:string) {
    this.panel = panel;
    this.returnFocus = returnFocus;
    setTimeout(() => {
      (document.querySelector(focusSelector) as HTMLElement)?.focus({ preventScroll: true });
    }, 0);
  }

  closePanel() {
    let returnTo = this.panel == 'confirmDelete' ? '[data-action="delete"]' : null;
    this.panel = null;
    if (returnTo) this.focus(returnTo);
    else this.show(this.returnFocus || 'name');
  }

  private chooseAvatar(avatar:string) {
    this.avatar = avatar;
    this.closePanel();
  }

  onNameDone(name:string) {
    this.name = name;
    this.error = '';
    this.closePanel();
  }

  onPinSet(pin:string) {
    this.pendingPin = pin;
    this.panel = null;
    this.show('pin');
  }

  onPinCancelled() {
    this.panel = null;
    this.show('pin');
  }

  // ── save / delete ─────────────────────────────────────────────────────────

  private save() {
    let name = this.name.trim();
    if (!name) {
      this.error = 'Please enter a name';
      this.show('name');
      return;
    }
    this.saving = true;
    this.error = '';

    let request:Observable<Profile>;
    if (!this.id) {
      request = this.profilesService.create({
        name, avatar: this.avatar, isKid: this.isKid, pin: this.pendingPin || undefined,
      });
    } else {
      request = this.profilesService.update(this.id, { name, avatar: this.avatar, isKid: this.isKid }).pipe(
        concatMap(p => this.pendingPin === undefined ? of(p) : this.profilesService.setPin(this.id, this.pendingPin)),
      );
    }

    request.subscribe({
      next: p => {
        this.profilesService.picker.focusId = p.id;
        this.router.navigateByUrl('/profiles');
      },
      error: err => {
        this.saving = false;
        this.error = ProfilesService.errorMessage(err);
        this.show('name');
      }
    });
  }

  private remove() {
    this.saving = true;
    this.profilesService.remove(this.id).subscribe({
      next: () => {
        this.profilesService.picker.focusId = null;
        this.router.navigateByUrl('/profiles');
      },
      error: err => {
        this.saving = false;
        this.closePanel();
        this.notification.sendNotification('error', ProfilesService.errorMessage(err));
      }
    });
  }

  private cancel() {
    this.router.navigateByUrl('/profiles');
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private fill(profile:Profile) {
    this.name = profile.name;
    this.avatar = AVATARS.includes(profile.avatar) ? profile.avatar : AVATARS[0];
    this.isKid = profile.isKid;
    this.hasPin = profile.hasPin;
    this.show('name');
  }

  // Render the form (first call) and focus one of its fields
  private show(field:string) {
    this.ready = true;
    this.focus(`.editorContent [data-field="${field}"]`);
  }

  private focus(selector:string) {
    setTimeout(() => (document.querySelector(selector) as HTMLElement)?.focus({ preventScroll: true }), 0);
  }
}
