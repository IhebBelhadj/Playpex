import { environment } from '../../../environments/environment';
import { CONTRIBUTIONS, defineContribution, defineScreen } from './hello-api';
import { helloPage } from './hello-data';
import { HelloSectionComponent } from './hello-section.component';
import { HelloTitleComponent } from './hello-title.component';

// The example plugin (docs/tv-plugins.md; navigation-system-plan.md step 7,
// ui-system-plan.md §7), development builds only. Compiled with the app (no
// plugin loader yet): what a plugin declares, and the rules it meets.
//
//   screens         plugin.hello.section (p/hello/home), plugin.hello.title (p/hello/title/:id);
//                   defined at load, not in the menu
//   contributions   an action on movie pages, a paged row in the Movies section;
//                   installed on demand so the core's screenshots stay the
//                   core's: window.playpexDev.plugin('hello', true | false)

export const HELLO_COMPONENTS = [HelloSectionComponent, HelloTitleComponent];

if (!environment.production) {
  defineScreen({
    id: 'plugin.hello.section',
    path: 'p/hello/home',
    component: HelloSectionComponent,
    kind: 'section',
    requires: ['profile'],
  });
  defineScreen<{ id:string }>({
    id: 'plugin.hello.title',
    path: 'p/hello/title/:id',
    component: HelloTitleComponent,
    kind: 'detail',
    requires: ['profile'],
  });
}

const IDS = ['plugin.hello.party', 'plugin.hello.picks'];

export function installHelloPlugin(on:boolean) {
  IDS.forEach(id => CONTRIBUTIONS.remove(id));
  if (!on || environment.production) return;
  defineContribution({
    id: 'plugin.hello.party',
    slot: 'core.movie.actions',
    order: 60,
    actions: ctx => ctx.movie.tmdbId ? [{
      key: 'hello:party', label: 'Hello', icon: 'film',
      intent: { screen: 'plugin.hello.title', params: { id: ctx.movie.tmdbId % 100 || 1 } },
    }] : [],
  });
  defineContribution({
    id: 'plugin.hello.picks',
    slot: 'core.movies.rows',
    order: 15,
    rows: () => [{ key: 'hello:picks', title: 'Hello picks (example plugin)', variant: 'poster', source: { page: helloPage } }],
  });
}
