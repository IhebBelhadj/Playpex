'use strict';

// A plugin secret's default from the server's environment (the repo root's
// .env, or the host's real environment), used while the admin entered none on
// the dashboard: the credentials a server provides to everyone, as Playpex's
// own TMDB key (e.g. the YouTube plugin's API key and Google client, so nobody
// makes a Google Cloud project). The name:
//
//   PLAYPEX_PLUGIN_<PLUGIN ID>_<SECRET NAME>   upper case, `-` and camelCase → `_`
//   youtube apiKey → PLAYPEX_PLUGIN_YOUTUBE_API_KEY, clientId → …_CLIENT_ID
//
// Only server secrets (no profile's). Never stored, never logged; the
// dashboard shows such a secret as set.

function variable(pluginId, name) {
  var snake = String(name).replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return ('PLAYPEX_PLUGIN_' + String(pluginId) + '_' + snake).replace(/-/g, '_').toUpperCase();
}

/** The environment's value, or null */
function get(pluginId, name) {
  var value = process.env[variable(pluginId, name)];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** `stored` (the admin's, null when none) or the environment's */
function orDefault(pluginId, name, stored) {
  return stored !== null && stored !== undefined && stored !== '' ? stored : get(pluginId, name);
}

module.exports = { variable: variable, get: get, orDefault: orDefault };
