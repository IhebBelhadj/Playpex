'use strict';

// /api/v1/sections, /api/v1/rows — a profile's rows per section (docs/rows-plan.md §7, lib/rows)
//   GET    /sections/:section/rows?profile=                     the resolved rows, in order
//   GET    /sections/:section/rows/:rowId/items?profile=&page=  one row's page
//   GET    /sections/:section/layout?profile=                   the layout to edit (its own, else the default)
//   PUT    /sections/:section/layout?profile=                   body { rows, known? }: the profile's own
//   DELETE /sections/:section/layout?profile=                   back to the default
//   GET    /rows/sources?profile=                               what the editors can add
// Anyone using a profile may change its rows; a kids profile's only the admin (decision A).

var express = require('express'),
  handle = require('./handle'),
  rows = require('../rows'),
  sessions = require('../sessions'),
  events = require('../events'),
  errors = require('../services/errors');

var router = express.Router();

function localeOf(req) {
  var first = String(req.get('Accept-Language') || '').split(',')[0].split(';')[0].trim();
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(first) ? first : 'en';
}

/** { profile: { id, kids } | null, device, locale } */
function contextOf(s, req, required) {
  var id = req.query.profile, device = sessions.device(req),
    ctx = { profile: null, device: { id: device.id, name: device.name || '' }, locale: localeOf(req) };
  if (!id) {
    if (required) {
      throw errors.invalid('profile is required');
    }
    return Promise.resolve(ctx);
  }
  if (typeof id !== 'string' || id.length > 100) {
    throw errors.invalid('profile must be a profile id');
  }
  return s.profiles.get(id).then(function (p) {
    ctx.profile = { id: p.id, kids: !!p.isKid };
    return ctx;
  });
}

/** Entries as an editor sends them back: without what the server added (new, label) */
function body(req) {
  var b = req.body && typeof req.body === 'object' ? Object.assign({}, req.body) : req.body;
  if (b && Array.isArray(b.rows)) {
    b.rows = b.rows.map(function (e) {
      if (e && typeof e === 'object' && !Array.isArray(e)) {
        e = Object.assign({}, e);
        delete e.new;
        delete e.label;
      }
      return e;
    });
  }
  return b;
}

/** Clients showing this section refetch its rows: `profileId` null = the admin's default (every profile without its own) */
function changed(section, profileId) {
  events.publish('rows.changed', { section: section, profileId: profileId || null });
}

function mayEdit(req, ctx) {
  if (ctx.profile.kids && !(req.auth && req.auth.kind === 'admin')) {
    throw errors.forbidden('A kids profile\'s rows are the admin\'s to change (on the dashboard)');
  }
}

router.get('/sections/:section/rows', handle(function (s, req) {
  return contextOf(s, req).then(function (ctx) { return rows.resolve(req.params.section, ctx); });
}));

router.get('/sections/:section/rows/:rowId/items', handle(function (s, req) {
  return contextOf(s, req).then(function (ctx) { return rows.items(req.params.section, req.params.rowId, req.query.page, ctx); });
}));

router.get('/sections/:section/layout', handle(function (s, req) {
  return contextOf(s, req, true).then(function (ctx) { return rows.editable(req.params.section, ctx); });
}));

router.put('/sections/:section/layout', handle(function (s, req) {
  return contextOf(s, req, true).then(function (ctx) {
    mayEdit(req, ctx);
    return s.layouts.set(ctx.profile.id, req.params.section, body(req)).then(function () {
      changed(req.params.section, ctx.profile.id);
      return rows.editable(req.params.section, ctx);
    });
  });
}));

router.delete('/sections/:section/layout', handle(function (s, req) {
  return contextOf(s, req, true).then(function (ctx) {
    mayEdit(req, ctx);
    return s.layouts.reset(ctx.profile.id, req.params.section).then(function () {
      changed(req.params.section, ctx.profile.id);
      return rows.editable(req.params.section, ctx);
    });
  });
}));

router.get('/rows/sources', handle(function (s, req) {
  return contextOf(s, req).then(function (ctx) { return rows.sources(ctx); });
}));

module.exports = router;
module.exports.body = body;
module.exports.changed = changed;
