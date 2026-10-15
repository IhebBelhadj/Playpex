'use strict';

// Metadata for the 18+ section (posters, overviews, studios, performers), from
// pluggable providers. The UI asks for one by id (the profile's choice, later
// in Settings) or gets the default: the first enabled one.
//
// A provider module exports:
//   id, name, description
//   isConfigured() → bool                     false: listed but disabled (missing key)
//   periods                                   [{ id, label }] release filters it supports
//   sorts                                     orders discover() supports, of 'popular' | 'newest' | 'rated'
//   home() → Promise<[{ key, title }]>        rows of the section's home
//   row(key, page) → Promise<Page>            one of those rows
//   discover({ studio, period, sort, page }) → Promise<Page>   filtered browsing, in one of its `sorts`
//   search({ q, period, page }) → Promise<Page>
//   studios() → Promise<[{ id, name }]>
//   title(id) → Promise<Title>
// Page  = { items: [Item], page, totalPages }
// Item  = { id, title, year, releaseDate, overview, poster, backdrop (full URLs or null),
//           rating (0–10 or null), studio: { id, name } | null }
// Title = Item + { runtime (minutes), performers: [{ name, photo }], director, studios: [{ id, name }] }
// Ids are the provider's own; the UI keeps the provider id next to them.

var PROVIDERS = [
  require('./providers/tmdb'),
  require('./providers/theporndb')
];

function ServiceError(status, message) {
  var err = new Error(message);
  err.status = status;
  return err;
}

function list() {
  var firstEnabled = PROVIDERS.filter(function (p) { return p.isConfigured(); })[0];
  return PROVIDERS.map(function (p) {
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      enabled: p.isConfigured(),
      default: p === firstEnabled,
      periods: p.periods,
      sorts: p.sorts || ['popular']
    };
  });
}

// id: wanted provider; unknown or disabled → error, missing → the default
function get(id) {
  if (!id) {
    var fallback = PROVIDERS.filter(function (p) { return p.isConfigured(); })[0];
    if (!fallback) {
      throw ServiceError(503, 'No 18+ metadata provider is configured');
    }
    return fallback;
  }
  var provider = PROVIDERS.filter(function (p) { return p.id === id; })[0];
  if (!provider) {
    throw ServiceError(404, 'Unknown metadata provider: ' + id);
  }
  if (!provider.isConfigured()) {
    throw ServiceError(503, provider.name + ' needs an API key (see .env.example)');
  }
  return provider;
}

module.exports = {
  list: list,
  get: get,
  ServiceError: ServiceError
};
