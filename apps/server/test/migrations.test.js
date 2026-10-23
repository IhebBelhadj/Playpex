'use strict';

// Migration tests: a database made by the migrations up to some point, then
// opened by lib/db (every migration).
//   0004 (docs/settings-plan.md §6): profiles' preferences.adult → profile_settings
//   0014 (docs/plugins-plan.md P5): those settings → the 18+ plugin's (its
//        profile setting metadataProvider, its store's layout:<profile>)
//
//   npm test -w apps/server

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  DatabaseSync = require('node:sqlite').DatabaseSync,
  database = require('../lib/db'),
  driver = require('../lib/db/driver');

var MIGRATIONS = path.join(__dirname, '..', 'lib', 'db', 'migrations');

// A copy of the migrations folder that stops after `lastTag`
function migrationsUpTo(dir, lastTag) {
  var journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')),
    last = journal.entries.findIndex(function (e) { return e.tag === lastTag; });
  assert.ok(last !== -1, lastTag + ' is not in the journal');
  journal.entries = journal.entries.slice(0, last + 1);
  fs.mkdirSync(path.join(dir, 'meta'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify(journal));
  journal.entries.forEach(function (e) {
    fs.copyFileSync(path.join(MIGRATIONS, e.tag + '.sql'), path.join(dir, e.tag + '.sql'));
  });
  return dir;
}

test('0004 then 0014: profiles.preferences.adult → profile_settings → the 18+ plugin', function () {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-migrations-')),
    file = path.join(tmp, 'playpex.db'),
    old = driver.open(file, database.schema);

  return old.migrate(migrationsUpTo(path.join(tmp, 'migrations'), '0002_auth')).then(function () {
    old.close();
    var raw = new DatabaseSync(file),
      insert = raw.prepare('INSERT INTO profiles (id, name, is_kid, preferences, created_at) VALUES (?, ?, 0, ?, ?)');
    insert.run('p-both', 'Both', JSON.stringify({ adult: { layout: 'compact', metadataProvider: 'theporndb' } }), Date.now());
    insert.run('p-layout', 'Layout', JSON.stringify({ adult: { layout: 'posters', metadataProvider: null } }), Date.now());
    insert.run('p-bad', 'Bad', JSON.stringify({ adult: { layout: 'grid' } }), Date.now());
    insert.run('p-none', 'None', JSON.stringify({}), Date.now());
    raw.close();
    return database.open({ file: file });
  }).then(function (connection) {
    connection.close();
    var raw = new DatabaseSync(file),
      core = raw.prepare('SELECT profile_id, key FROM profile_settings').all(),
      settings = raw.prepare('SELECT plugin_id, scope, owner_id, key, value, updated_at FROM plugin_settings ORDER BY owner_id').all(),
      store = raw.prepare('SELECT plugin_id, key, value, size FROM plugin_store ORDER BY key').all();
    raw.close();
    assert.deepEqual(core, [], 'no 18+ key left in the core');
    assert.deepEqual(settings.map(function (r) { return [r.plugin_id, r.scope, r.owner_id, r.key, JSON.parse(r.value)]; }), [
      ['adult', 'profile', 'p-both', 'metadataProvider', 'theporndb']
    ]);
    assert.ok(Math.abs(settings[0].updated_at - Date.now()) < 60 * 1000, 'updated_at is epoch ms');
    assert.deepEqual(store.map(function (r) { return [r.plugin_id, r.key, JSON.parse(r.value), r.size]; }), [
      ['adult', 'layout:p-both', 'list', Buffer.byteLength('"list"') + Buffer.byteLength('layout:p-both')],
      ['adult', 'layout:p-layout', 'posters', Buffer.byteLength('"posters"') + Buffer.byteLength('layout:p-layout')]
    ]);
  }).finally(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
