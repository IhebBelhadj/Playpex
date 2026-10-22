import { delay, Observable, of } from 'rxjs';
import type { CardModel, RowPage } from '../../ui/public-api';

// Fixture data of the example plugin: no network, a few pages of cards. A
// real plugin would call its own API (docs/tv-plugins.md: data access is a
// later plan).

export interface HelloTitle {
  id:number;
  title:string;
  year:string;
  overview:string;
}

const WORDS = ['Quiet', 'Paper', 'Night', 'River', 'Glass', 'Northern', 'Last', 'Silver', 'Hidden', 'Small'];
const NOUNS = ['Harbour', 'Letters', 'Signal', 'Garden', 'Engine', 'Lights', 'Season', 'Bridge', 'Archive', 'Hours'];

export function helloTitle(id:number):HelloTitle {
  return {
    id,
    title: `${WORDS[id % WORDS.length]} ${NOUNS[Math.floor(id / WORDS.length) % NOUNS.length]}`,
    year: String(1990 + (id * 7) % 35),
    overview: 'A title of the example plugin (src/app/plugins-dev/hello): made up, to show a plugin row, ' +
      'a plugin section and a plugin detail screen built from the UI system.',
  };
}

export function helloCard(id:number):CardModel {
  let t = helloTitle(id);
  return { key: `hello:${id}`, title: t.title, subtitle: t.year, intent: { screen: 'plugin.hello.title', params: { id } } };
}

// pages of 12 cards, 3 pages, a little later (as from a server)
export function helloPage(n:number):Observable<RowPage> {
  let items = Array.from({ length: 12 }, (_, i) => helloCard((n - 1) * 12 + i + 1));
  return of({ items, last: n >= 3 }).pipe(delay(150));
}
