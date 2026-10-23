import { PluginCatalogComponent } from './plugin-catalog.component';
import { PluginListComponent } from './plugin-list.component';
import { PluginReleasesComponent } from './plugin-releases.component';
import { PluginTitleComponent } from './plugin-title.component';

// The screen templates a packaged plugin's screens are drawn with
// (docs/plugins/templates.md); declared in AppModule
export const PLUGIN_TEMPLATES = [PluginCatalogComponent, PluginTitleComponent, PluginReleasesComponent, PluginListComponent];
