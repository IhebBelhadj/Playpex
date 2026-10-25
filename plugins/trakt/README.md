# Trakt

A first-party plugin (`docs/plugins-plan.md` §7.3, step P6; a metadata provider of `docs/providers-plan.md` §7.3) that ties a profile to a [Trakt](https://trakt.tv) account. It is published in the **official repository** (`https://ihebbelhadj.github.io/playpex-official/index.json`, built into every server; how to rebuild it: `~/projects/playpex-plugins/official/README.md`).

| What | How |
|---|---|
| Trakt's rating on title pages (movies, shows) and a link to the title on Trakt | `metadata.details` (the app's client id only; cached an hour) |
| Scrobbling: Trakt's "watching now", then its history (a stop past 80 %) | `playback.*` events → `/scrobble/start|pause|stop`: start, pause, start again on the next report, one stop (finished, then left) |
| The profile's watch list, watched marks and ratings sent to Trakt | `watchlist.*`, `watched.*`, `rating.set` events (the profile's own, never the plugin's writes); a scrobbled title isn't sent to the history a second time |
| Trakt → Playpex: the watch list both ways (removals too), the history since the last sync (the first: 30 days), ratings | a job every 15 min, each profile when its interval (Settings: 15 min, 1 h, 6 h) is up; a notification of what it added |
| "Trending on Trakt", "Recommended for you on Trakt" (linked) rows in Movies / TV shows | `core.movies.rows` / `core.shows.rows` (posters from the server's TMDB) |

## Setting it up (the dashboard)

1. **Plugins › Browse**: install Trakt from the Playpex repository.
2. Create a Trakt app at `trakt.tv/oauth/applications` (redirect URI `urn:ietf:wg:oauth:2.0:oob`), then **Plugins › Trakt › Settings** (advanced): its client id and secret. The ratings and the trending rows work from here.
3. **Profiles**: for each profile that should use it, switch on what it may do: `events.playback` (scrobbling), `write.watchlist`, `write.watched`, `write.ratings` (the sync). Nothing is sent or synced for a profile that isn't granted.
4. **Accounts**: **Link** a profile: the dashboard shows a code; whoever owns the Trakt account enters it at `trakt.tv/activate`.
5. A profile's own options (same page, Profiles): scrobbling on / off, what to sync (all, the watch list only, nothing), the sync's notifications. **Sync now** syncs every linked profile at once.

## Notes

- Titles go both ways by TMDB id (Trakt has them); an episode on the watch list is its show (as in Playpex).
- The plugin keeps in its store what it sent (7 days), what Trakt's watch list held at the last sync and when that was; **Clear data** forgets them (the next sync is a first one again: it merges, nothing is lost).
- Tests: `apps/server/test/plugins.trakt.test.js` (its `server.js` against a fake Trakt API, then loaded by a real server). Not tried against Trakt itself yet: that needs a Trakt app and account.
