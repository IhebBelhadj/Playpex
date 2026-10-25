'use strict';

// The official Playpex plugin repository (docs/plugins-plan.md §6.1): built
// in, its key ships with the server, the admin can turn it off but never edit
// it. It never carries an `audience: adults` plugin (./repositories.js refuses
// one in its index, ./install.js a package from it): an adults plugin is
// published in a repository of its own, which the admin adds deliberately.
//
// Hosted on GitHub Pages (decided 2026-10-25; built in
// ~/projects/playpex-plugins/official with `npm run pack:repository`, its key
// kept by the publisher, never in this repository): its first plugin is Trakt
// (plugins/trakt). Without url / key there would be no built-in repository.
// Tests give their own with the start option `repositories.official`.

module.exports = {
  id: 'playpex',
  name: 'Playpex',
  url: 'https://ihebbelhadj.github.io/playpex-official/index.json',   // its signature at <url>.sig
  key: 'ed25519:jwgCJg+cIkeB3780604xy4dhMrngT4h4NJrT2Nas2cw='           // fingerprint 1440 8b9d b5d7 cf14 eac7 2c7b c4ea 0738
};
