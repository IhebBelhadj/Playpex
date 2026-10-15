'use strict';

// Database driver: Node's built-in SQLite (node:sqlite, bundled with Electron's
// Node 24, so no native module to rebuild) behind Drizzle's sqlite-proxy adapter.
// Drizzle 0.45 has no node:sqlite driver of its own; when one ships (or to move
// to better-sqlite3 / libsql), only this file changes.
//
// node:sqlite is synchronous: every query runs to completion inside the proxy
// callback, so statements never interleave. Drizzle's db.transaction() is NOT
// safe here (its BEGIN/COMMIT are separate async calls and other requests can
// run in between); use db.batch([...]) for atomic multi-statement writes, it
// runs the whole batch in one BEGIN/COMMIT without yielding.

var DatabaseSync = require('node:sqlite').DatabaseSync,
  proxy = require('drizzle-orm/sqlite-proxy'),
  proxyMigrator = require('drizzle-orm/sqlite-proxy/migrator');

var STATEMENT_CACHE_SIZE = 200;

// SQLITE_CONSTRAINT_UNIQUE, SQLITE_CONSTRAINT_PRIMARYKEY
var UNIQUE_ERRCODES = [2067, 1555];

// Drizzle wraps driver errors (DrizzleQueryError) and keeps the original as `cause`
function isUniqueViolation(err) {
  for (var e = err; e; e = e.cause) {
    if (UNIQUE_ERRCODES.indexOf(e.errcode) !== -1) {
      return true;
    }
  }
  return false;
}

// node:sqlite only binds null, numbers, bigints, strings and buffers
function bindable(value) {
  if (value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  return value;
}

/**
 * Open (or create) a database file and wrap it with Drizzle.
 * @param {string} file path, or ':memory:'
 * @param {object} schema the table definitions (./schema.js)
 * @returns {{ db: object, migrate: function(string): Promise, close: function() }}
 */
function open(file, schema) {
  var sqlite = new DatabaseSync(file);
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA busy_timeout = 5000');
  if (file !== ':memory:') {
    sqlite.exec('PRAGMA journal_mode = WAL');
  }

  var statements = new Map();

  function prepare(text) {
    var statement = statements.get(text);
    if (!statement) {
      statement = sqlite.prepare(text);
      // Drizzle maps columns by position (joins can repeat column names)
      statement.setReturnArrays(true);
      if (statements.size >= STATEMENT_CACHE_SIZE) {
        statements.delete(statements.keys().next().value);
      }
      statements.set(text, statement);
    }
    return statement;
  }

  // The sqlite-proxy contract: 'run' → anything, 'get' → { rows: row | undefined },
  // 'all' / 'values' → { rows: row[] }, every row an array of column values.
  function execute(text, params, method) {
    var statement = prepare(text),
      args = (params || []).map(bindable);
    if (method === 'run') {
      statement.run.apply(statement, args);
      return { rows: [] };
    }
    if (method === 'get') {
      return { rows: statement.get.apply(statement, args) };
    }
    return { rows: statement.all.apply(statement, args) };
  }

  function inTransaction(work) {
    sqlite.exec('BEGIN');
    try {
      var result = work();
      sqlite.exec('COMMIT');
      return result;
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw err;
    }
  }

  var db = proxy.drizzle(
    function (text, params, method) {
      return Promise.resolve().then(function () {
        return execute(text, params, method);
      });
    },
    function (queries) {
      return Promise.resolve().then(function () {
        return inTransaction(function () {
          return queries.map(function (q) {
            return execute(q.sql, q.params, q.method);
          });
        });
      });
    },
    { schema: schema }
  );

  return {
    db: db,
    migrate: function (migrationsFolder) {
      return proxyMigrator.migrate(db, function (queries) {
        inTransaction(function () {
          queries.forEach(function (q) {
            sqlite.exec(q);
          });
        });
        return Promise.resolve();
      }, { migrationsFolder: migrationsFolder });
    },
    close: function () {
      statements.clear();
      sqlite.close();
    }
  };
}

module.exports = {
  open: open,
  isUniqueViolation: isUniqueViolation
};
