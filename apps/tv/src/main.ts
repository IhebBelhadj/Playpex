import { enableProdMode } from '@angular/core';
import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';

import { AppModule } from './app/app.module';
import { resolveServer } from './app/server-config';
import { environment } from './environments/environment';

if (environment.production) {
  enableProdMode();
}

// The server is known before anything asks for it (server-config.ts)
resolveServer()
  .catch(err => console.error('No server: ', err))
  .then(() => platformBrowserDynamic().bootstrapModule(AppModule))
  .catch(err => console.error(err));
