'use strict';

// Migration test (docs/settings-plan.md §6): a database made by the migrations
// up to 0002 (before settings) with profiles holding preferences.adult, then
// opened by lib/db (every migration) → the values are in profile_settings.
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

test('0004 moves profiles.preferences.adult into profile_settings', function () {
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
      rows = raw.prepare('SELECT profile_id, key, value, updated_at FROM profile_settings ORDER BY profile_id, key').all();
    raw.close();
    assert.deepEqual(rows.map(function (r) { return [r.profile_id, r.key, JSON.parse(r.value)]; }), [
      ['p-both', 'adult.layout', 'compact'],
      ['p-both', 'adult.metadataProvider', 'theporndb'],
      ['p-layout', 'adult.layout', 'posters']
    ]);
    rows.forEach(function (r) { assert.ok(Math.abs(r.updated_at - Date.now()) < 60 * 1000, 'updated_at is epoch ms'); });
  }).finally(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
