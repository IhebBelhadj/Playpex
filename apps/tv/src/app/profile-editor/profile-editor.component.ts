import { AfterViewInit, Component, OnDestroy, OnInit } from '@angular/core';
import { concatMap, Observable, of } from 'rxjs';
import { NotificationService } from '../notification.service';
import { AVATARS, Profile, ProfilesService } from '../profiles.service';
import { LayerRef, LayerStack, Navigator, useScreen } from '../nav/public-api';

type Panel = null | 'keyboard' | 'avatars' | 'pin' | 'confirmDelete';

// Overlay panels and their navigation sections (restrict self-only while
// open), each a layer of the nav system: the avatars and the delete
// confirmation here, the name keyboard (<text-keyboard>) and the PIN pad
// their own.
const NAME_MAX = 30;

// /profiles/new and /profiles/:id/edit. Changes are kept locally and sent on
// Save (profile fields, then the PIN if it changed). Back closes the open panel,
// otherwise cancels (back to the picker: the nav system's pop).
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

  private returnFocus:string | null = null;
  private panelLayer:LayerRef | null = null;
  private screen = useScreen<{ id?:string }>();

  constructor(
    private profilesService:ProfilesService,
    private navigator:Navigator,
    private layers:LayerStack,
    private notification:NotificationService,
  ) { }

  get pinActive():boolean {
    return this.pendingPin === undefined ? this.hasPin : this.pendingPin !== null;
  }

  ngOnInit(): void {
    this.id = this.screen.params.id || null;

    if (this.id) {
      this.profilesService.get(this.id).subscribe({
        next: p => this.fill(p),
        error: err => {
          this.notification.sendNotification('error', ProfilesService.errorMessage(err));
          this.toPicker();
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

    this.screen.onSelect(active => {
      if (this.saving) return;
      let data = active.dataset;
      if (data['field']) this.activateField(data['field']);
      else if (data['action']) this.activateAction(data['action']);
    });
    // saving: stay until it's done
    this.screen.onBack(() => this.saving);
    this.screen.onLeave(() => this.saving);
  }

  ngOnDestroy(): void {
    this.panelLayer?.close();
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
    let layer = this.panelLayer = this.layers.open({
      id: panel,
      element: () => document.querySelector(panel == 'avatars' ? '.avatarPanel' : '.confirmPanel'),
      restoreFocus: false,
    });
    layer.onSelect(active => {
      let data = active.dataset;
      if (this.saving) return;
      if (data['avatar']) this.chooseAvatar(data['avatar']);
      else if (data['confirm']) data['confirm'] == 'yes' ? this.remove() : this.closePanel();
    });
    layer.onBack(() => {
      if (!this.saving) this.closePanel();
      return true;
    });
    setTimeout(() => {
      (document.querySelector(focusSelector) as HTMLElement)?.focus({ preventScroll: true });
    }, 0);
  }

  closePanel() {
    let returnTo = this.panel == 'confirmDelete' ? '[data-action="delete"]' : null;
    this.panel = null;
    this.panelLayer?.close();
    this.panelLayer = null;
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
        this.toPicker();
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
        this.toPicker();
      },
      error: err => {
        this.saving = false;
        this.closePanel();
        this.notification.sendNotification('error', ProfilesService.errorMessage(err));
      }
    });
  }

  private cancel() {
    this.toPicker();
  }

  // Back to "Who's watching?" (below in the history, else a fresh one)
  private toPicker() {
    this.navigator.backTo('core.profiles').then(ok => ok || this.navigator.reset({ screen: 'core.profiles' }));
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
