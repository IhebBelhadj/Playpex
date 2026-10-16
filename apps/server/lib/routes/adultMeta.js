'use strict';

// /api/adult/meta: the 18+ section's catalog (lib/adultMeta). Every request
// is answered: provider errors → their status, upstream failures → 502.
//   GET /providers
//   GET /:provider/home                       → { rows: [{ key, title }] }
//   GET /:provider/rows/:key?page=            → Page
//   GET /:provider/discover?studio=&period=&sort=popular|newest|rated&page=   → Page
//   GET /:provider/search?q=&period=&page=    → Page
//   GET /:provider/studios                    → [{ id, name }]
//   GET /:provider/titles/:id                 → Title
// :provider = 'default' for the server's default

var express = require('express'),
  adultMeta = require('../adultMeta'),
  log = require('../logger').child('provider');

var router = express.Router();

function answer(work) {
  return function (req, res) {
    Promise.resolve().then(function () {
      var provider = adultMeta.get(req.params.provider === 'default' ? null : req.params.provider);
      return work(provider, req);
    }).then(function (result) {
      res.json(result);
    }, function (err) {
      var status = err.status || (err.response ? 502 : 500);
      if (status >= 500) {
        log.warn('adult meta ' + req.path + ': ' + err.message);
      }
      res.status(status).json({ error: err.message });
    });
  };
}

function page(req) {
  return Math.max(1, parseInt(req.query.page, 10) || 1);
}

router.get('/providers', function (req, res) {
  res.json(adultMeta.list());
});

router.get('/:provider/home', answer(function (p) {
  return p.home().then(function (rows) { return { provider: p.id, rows: rows }; });
}));

router.get('/:provider/rows/:key', answer(function (p, req) {
  return p.row(req.params.key, page(req));
}));

router.get('/:provider/discover', answer(function (p, req) {
  return p.discover({
    studio: req.query.studio || null,
    period: req.query.period || '',
    sort: req.query.sort || 'popular',
    page: page(req)
  });
}));

router.get('/:provider/search', answer(function (p, req) {
  return p.search({ q: String(req.query.q || '').slice(0, 100), period: req.query.period || '', page: page(req) });
}));

router.get('/:provider/studios', answer(function (p) {
  return p.studios();
}));

router.get('/:provider/titles/:id', answer(function (p, req) {
  return p.title(req.params.id);
}));

module.exports = router;
