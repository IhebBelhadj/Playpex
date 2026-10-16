import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, tap } from 'rxjs';
import { ServerService } from './server.service';

// Profiles live in the server's database (apps/server/lib/services/profiles.js).
export interface Profile {
  id: string;
  name: string;
  avatar: string | null;         // an id from AVATARS
  isKid: boolean;
  hasPin: boolean;
  preferences: { [key: string]: any };
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ProfileList {
  profiles: Profile[];
  lastUsedId: string | null;
  maxProfiles: number;
}

// Files in apps/tv/src/assets/avatars
export const AVATARS = Array.from({ length: 12 }, (_, i) => `avatar-${String(i + 1).padStart(2, '0')}`);

export const PIN_LENGTH = 4;

@Injectable({
  providedIn: 'root'
})
export class ProfilesService {

  // The profile that is watching; null until one is picked on /profiles
  current = new BehaviorSubject<Profile | null>(null);

  // "Who's watching?" state kept across trips to the editor
  picker = { managing: false, focusId: null as string | null };

  private base = `${this.server.api}/profiles`;

  constructor(private http:HttpClient, private server:ServerService) { }

  static avatarUrl(avatar:string | null):string {
    return `assets/avatars/${AVATARS.includes(avatar) ? avatar : AVATARS[0]}.svg`;
  }

  // Server error message ("Wrong PIN", "A profile with this name already exists", …)
  static errorMessage(err:HttpErrorResponse):string {
    if (err.status === 0) return "Can't reach the Playpex server";
    return (err.error && err.error['error']) || 'Something went wrong';
  }

  list():Observable<ProfileList> {
    return this.http.get<ProfileList>(this.base);
  }

  get(id:string):Observable<Profile> {
    return this.http.get<Profile>(`${this.base}/${id}`);
  }

  create(input:{ name:string, avatar?:string, isKid?:boolean, pin?:string }):Observable<Profile> {
    return this.http.post<Profile>(this.base, input);
  }

  update(id:string, patch:{ name?:string, avatar?:string, isKid?:boolean, preferences?:object }):Observable<Profile> {
    return this.http.put<Profile>(`${this.base}/${id}`, patch).pipe(tap(p => this.refreshCurrent(p)));
  }

  // pin null removes the lock
  setPin(id:string, pin:string | null):Observable<Profile> {
    return this.http.put<Profile>(`${this.base}/${id}/pin`, { pin }).pipe(tap(p => this.refreshCurrent(p)));
  }

  remove(id:string):Observable<{ ok:boolean }> {
    return this.http.delete<{ ok:boolean }>(`${this.base}/${id}`).pipe(tap(() => {
      if (this.current.value?.id === id) this.current.next(null);
    }));
  }

  // Select a profile (checks the PIN when it has one) and make it current
  unlock(id:string, pin?:string):Observable<Profile> {
    return this.http.post<Profile>(`${this.base}/${id}/unlock`, { pin }).pipe(tap(p => this.current.next(p)));
  }

  private refreshCurrent(profile:Profile) {
    if (this.current.value?.id === profile.id) this.current.next(profile);
  }
}
