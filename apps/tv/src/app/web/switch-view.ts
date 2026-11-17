import { API_PREFIX } from '@playpex/protocol';

// Switch view (docs/web-unified-plan.md §5): Playpex Mobile on the web, from
// here. /app/ remembers the choice for this browser and translates the place
// (`at`) into the other client's address; the profile follows through the
// tab's sessionStorage (session-restore.ts `playpex.web.profile`).

let available:Promise<boolean> | null = null;

/** Playpex Mobile is served here (GET /clients: on and built); asked once per page */
export function phoneViewAvailable():Promise<boolean> {
  if (!available) {
    available = fetch(window.location.origin + API_PREFIX + '/clients', { credentials: 'same-origin' })
      .then(res => res.ok ? res.json() : null)
      .then(body => !!body?.web?.some((c:any) => c.id == 'mobile' && c.enabled && c.built))
      .catch(() => false);
  }
  return available;
}

/** A Playpex TV path as a place both clients know (home when it has none) */
export function placeOf(url:string):string {
  let path = (url || '').split(/[?#]/)[0].replace(/^\/+/, '').replace(/\/+$/, '');
  let m:RegExpExecArray | null;
  if ((m = /^movies\/movie\/(\d+)$/.exec(path))) return 'title/movie/' + m[1];
  if ((m = /^shows\/show\/(\d+)(\/|$)/.exec(path))) return 'title/tv/' + m[1];
  if ((m = /^people\/(\d+)$/.exec(path))) return 'person/' + m[1];
  let sections:Record<string, string> = {
    'home/list': 'home', 'movies/list': 'movies', 'shows/list': 'shows', search: 'search', watchlist: 'mylist', settings: 'settings',
  };
  return sections[path] || 'home';
}

export function switchToPhoneView(at:string) {
  window.location.assign('/app/?view=mobile&at=' + encodeURIComponent(at));
}
