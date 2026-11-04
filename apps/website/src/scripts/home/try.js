// DRAFT (to delete once the user picks): options of the home page to compare, chosen in the address with
// ?try=load-b,rooms-a (index.astro's first script sets html.try-<name> before the first paint). Without
// ?try the page is the agreed one.
const params = new URLSearchParams(location.search);
export const comparing = params.has('try');
const chosen = (params.get('try') || '').split(',').filter(Boolean);
export const has = (name) => chosen.includes(name);

const GROUPS = [
  ['Loading screen', [['', 'As now'], ['load-b', 'B · Only when needed'], ['load-c', 'C · Headline first']]],
  ['Phone rooms', [['', 'As now'], ['rooms-a', 'A · Picture peeks'], ['rooms-b', 'B · Peeks in dots']]],
];

// a small panel to switch options (each click reloads with the new set)
export function picker() {
  if (!comparing) return;
  const el = document.createElement('details');
  el.className = 'try-panel';
  el.innerHTML = '<summary>Options</summary>' + GROUPS.map(([title, opts]) => {
    const prefix = opts[1][0].split('-')[0];
    const cur = chosen.find((c) => c.startsWith(prefix + '-')) || '';
    return '<div><b>' + title + '</b>' + opts.map(([id, label]) => {
      const next = chosen.filter((c) => !c.startsWith(prefix + '-')).concat(id ? [id] : []);
      const u = new URL(location.href); u.searchParams.set('try', next.join(',')); u.hash = '';
      return '<a href="' + u.pathname + u.search + '"' + (id === cur ? ' aria-current="true"' : '') + '>' + label + '</a>';
    }).join('') + '</div>';
  }).join('');
  document.body.appendChild(el);
}
