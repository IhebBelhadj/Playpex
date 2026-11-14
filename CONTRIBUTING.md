# Contributing to Playpex

Contributions are welcome: bug reports, fixes, features, plugins, docs and translations.

## How

1. Open an issue first for anything larger than a small fix, so we can agree on the approach.
2. Fork the repository, make your change on a branch, and open a pull request against `main`.
3. Read the guide for the part you change before you start: [CLAUDE.md](CLAUDE.md) and the `CLAUDE.md` next to each app
   (`apps/*/CLAUDE.md`), and the plans in [`docs/`](docs/) they point to.
4. Run the checks that apply: `npm run test:server`, `npm run check:plugins`, `npm run check:ui`.

## Your contribution's licence

Playpex is under the PolyForm Noncommercial License 1.0.0 ([LICENSE.md](LICENSE.md)): anyone may use and change it for
noncommercial purposes, and nobody but its licensor may sell it or use it commercially (plugins are the exception: see
"Plugins" in [LICENSE.md](LICENSE.md)). By opening a pull request you agree that:

- your contribution is your own work, or you have the right to submit it;
- it is licensed under the same PolyForm Noncommercial License 1.0.0 as the rest of Playpex, or under the MIT License
  when it changes the plugin kit (listed under "Plugins" in [LICENSE.md](LICENSE.md));
- you also grant Iheb Belhadj a perpetual, worldwide, irrevocable, royalty-free licence to use, change, sublicense and
  commercially license your contribution, under any terms, so Playpex can be licensed commercially and its licence can
  change later without asking every contributor again.

Contributions to the parts under other licences (see "What this licence does not cover" in [LICENSE.md](LICENSE.md)), such
as `apps/mobile/modules/expo-mpv/` or the GPL plugin ports, are under those parts' own licences.

A fork you share keeps the copyright notice and needs a name and logo of its own (see "The Playpex name and logo" in
[LICENSE.md](LICENSE.md)).

Don't add code you copied from elsewhere unless its licence allows it here; say where it came from in the pull request.
