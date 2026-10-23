'use strict';

// The official Playpex plugin repository (docs/plugins-plan.md §6.1): built
// in, its key ships with the server, the admin can turn it off but never edit
// it. It never carries an `audience: adults` plugin (./repositories.js refuses
// one in its index, ./install.js a package from it): an adults plugin is
// published in a repository of its own, which the admin adds deliberately.
//
// Not published yet (plan §10: where it lives, who holds its key): with no
// url / key there is no built-in repository. Tests give one with the start
// option `repositories.official`.

module.exports = {
  id: 'playpex',
  name: 'Playpex',
  url: null,      // https://…/index.json (its signature at <url>.sig)
  key: null       // ed25519:…
};
