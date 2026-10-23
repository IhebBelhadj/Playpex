'use strict';

var orm = require('drizzle-orm'),
  schema = require('../../db/schema'),
  util = require('./util');

var folders = schema.libraryFolders,
  files = schema.mediaFiles,
  items = schema.mediaItems;

// Part of the path or of the matched title (case-insensitive for ASCII, like SQLite's LIKE)
function contains(text) {
  var pattern = '%' + text.replace(/[\\%_]/g, '\\$&') + '%';
  return orm.sql`(${files.relPath} like ${pattern} escape '\\' or ${items.title} like ${pattern} escape '\\')`;
}

/** @returns {import('../contracts').LibraryRepository} */
module.exports = function libraryRepository(db) {
  return {
    listFolders: function () {
      return db.select().from(folders).orderBy(orm.asc(folders.addedAt));
    },

    findFolder: function (id) {
      return db.select().from(folders).where(orm.eq(folders.id, id)).limit(1).then(util.first);
    },

    insertFolder: function (record) {
      return db.insert(folders).values(record).returning().then(util.first, util.translate('This folder is already in the library'));
    },

    updateFolder: function (id, patch) {
      return db.update(folders).set(patch).where(orm.eq(folders.id, id)).returning().then(util.first);
    },

    // Its files go with it (ON DELETE CASCADE); nothing on disk is touched
    removeFolder: function (id) {
      return db.delete(folders).where(orm.eq(folders.id, id)).returning({ id: folders.id })
        .then(function (rows) { return rows.length > 0; });
    },

    listFiles: function (folderId) {
      return db.select().from(files).where(orm.eq(files.folderId, folderId)).orderBy(orm.asc(files.relPath));
    },

    findFile: function (id) {
      return db.select().from(files).where(orm.eq(files.id, id)).limit(1).then(util.first);
    },

    insertFile: function (record) {
      return db.insert(files).values(record).returning().then(util.first, util.translate('This file is already in the library'));
    },

    updateFile: function (id, patch) {
      return db.update(files).set(patch).where(orm.eq(files.id, id)).returning().then(util.first);
    },

    removeFile: function (id) {
      return db.delete(files).where(orm.eq(files.id, id)).returning({ id: files.id })
        .then(function (rows) { return rows.length > 0; });
    },

    queryFiles: function (query) {
      var where = orm.and(
        query.folderId ? orm.eq(files.folderId, query.folderId) : undefined,
        query.state ? orm.eq(files.state, query.state) : undefined,
        query.itemId ? orm.eq(files.itemId, query.itemId) : undefined,
        query.q ? contains(query.q) : undefined
      );
      return Promise.all([
        db.select({ file: files, item: items }).from(files).leftJoin(items, orm.eq(files.itemId, items.id))
          .where(where).orderBy(orm.desc(files.addedAt), orm.asc(files.relPath)).limit(query.limit).offset(query.offset),
        db.select({ count: orm.count() }).from(files).leftJoin(items, orm.eq(files.itemId, items.id)).where(where)
      ]).then(function (r) {
        return {
          rows: r[0].map(function (row) { return Object.assign({}, row.file, { item: row.item || null }); }),
          total: r[1][0].count
        };
      });
    },

    // Files a client may see (ok / unmatched) in folders of these audiences, each
    // with its item and a few fields of its folder
    listShown: function (query) {
      return db.select({
        file: {
          id: files.id, folderId: files.folderId, relPath: files.relPath, size: files.size, state: files.state,
          addedAt: files.addedAt, probe: files.probe, parse: files.parse, subtitles: files.subtitles
        },
        item: items,
        folder: { kind: folders.kind, path: folders.path, builtin: folders.builtin, dlna: folders.dlna }
      }).from(files).innerJoin(folders, orm.eq(files.folderId, folders.id)).leftJoin(items, orm.eq(files.itemId, items.id))
        .where(orm.and(
          orm.inArray(files.state, ['ok', 'unmatched']),
          orm.inArray(folders.audience, query.audiences),
          query.folderId ? orm.eq(files.folderId, query.folderId) : undefined
        )).then(function (rows) {
          return rows.map(function (row) {
            return Object.assign({}, row.file, { item: row.item || null, folder: row.folder });
          });
        });
    },

    // The files (state ok) of a movie, or of every episode of a show, in folders of these audiences
    titleFiles: function (query) {
      var title = query.kind === 'movie' ?
        orm.and(orm.eq(items.kind, 'movie'), orm.eq(items.tmdbId, query.tmdbId)) :
        orm.and(orm.eq(items.kind, 'episode'), orm.eq(items.showTmdbId, query.tmdbId));
      return db.select({ id: files.id, season: items.season, episode: items.episode })
        .from(files).innerJoin(items, orm.eq(files.itemId, items.id)).innerJoin(folders, orm.eq(files.folderId, folders.id))
        .where(orm.and(title, orm.eq(files.state, 'ok'), orm.inArray(folders.audience, query.audiences)));
    },

    countFiles: function () {
      return db.select({ folderId: files.folderId, state: files.state, count: orm.count() })
        .from(files).groupBy(files.folderId, files.state);
    },

    removeMissingBefore: function (date) {
      return db.delete(files).where(orm.and(orm.eq(files.state, 'missing'), orm.lt(files.missingSince, date)))
        .returning({ id: files.id }).then(function (rows) { return rows.length; });
    },

    findItem: function (id) {
      return db.select().from(items).where(orm.eq(items.id, id)).limit(1).then(util.first);
    },

    findItemFor: function (identity) {
      var where = identity.kind === 'movie' ?
        orm.and(orm.eq(items.kind, 'movie'), orm.eq(items.tmdbId, identity.tmdbId)) :
        orm.and(orm.eq(items.kind, 'episode'), orm.eq(items.showTmdbId, identity.showTmdbId),
          orm.eq(items.season, identity.season), orm.eq(items.episode, identity.episode));
      return db.select().from(items).where(where).limit(1).then(util.first);
    },

    insertItem: function (record) {
      return db.insert(items).values(record).returning().then(util.first);
    },

    updateItem: function (id, patch) {
      return db.update(items).set(patch).where(orm.eq(items.id, id)).returning().then(util.first);
    },

    removeOrphanItems: function () {
      return db.delete(items)
        .where(orm.notExists(db.select({ id: files.id }).from(files).where(orm.eq(files.itemId, items.id))))
        .returning({ id: items.id }).then(function (rows) { return rows.length; });
    }
  };
};
