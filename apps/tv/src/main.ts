import { enableProdMode } from '@angular/core';
import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';

import { AppModule } from './app/app.module';
import { resolveServer } from './app/server-config';
import { resolveDisplay } from './app/ui/display';
import { environment } from './environments/environment';

if (environment.production) {
  enableProdMode();
}

// The server is known before anything asks for it (server-config.ts), and the
// UI has its size before the first frame (ui/display.ts)
Promise.all([
  resolveServer().catch(err => console.error('No server: ', err)),
  resolveDisplay(),
])
  .then(() => platformBrowserDynamic().bootstrapModule(AppModule))
  .catch(err => console.error(err));
