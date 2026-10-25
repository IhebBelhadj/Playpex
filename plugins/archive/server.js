// Internet Archive (docs/search-plan.md §3, the reference sources.search
// plugin): the moving-image collection searched by title words (every word
// in the title), most downloaded first; each film's metadata read for its
// video files (h.264 MP4 / Matroska, WebM; no XviD, no 512 kb previews), the
// best few answered as http sources the server plays and downloads.
// archive.org/download/<id>/<file> redirects to a numbered *.archive.org host.

var PAGE = 6,
  FILES_PER_ITEM = 3,
  VIDEO = /\.(mp4|m4v|mkv|webm)$/i,
  // h.264 (MP4 or Matroska), WebM; never the plain "MPEG4" format (MPEG-4 Part 2, XviD: no browser decodes it)
  FORMATS = /h\.264|matroska|webm/i;

function words(text) {
  return String(text || '').replace(/[^\p{L}\p{N}\s]+/gu, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 8);
}

function search(query, page, year) {
  var title = words(query).map(function (w) { return w.replace(/[^\p{L}\p{N}]/gu, ''); }).join(' AND ');
  var url = 'https://archive.org/advancedsearch.php?q=' + encodeURIComponent('title:(' + title + ') AND mediatype:movies' + (year ? ' AND year:' + year : '')) +
    '&fl[]=identifier&fl[]=title&fl[]=year&rows=' + PAGE + '&page=' + page + '&output=json&sort[]=downloads+desc';
  return playpex.http.request({ url: url, responseType: 'json' }).then(function (r) {
    if (r.status !== 200 || !r.body || !r.body.response) {
      throw new Error('Internet Archive search: HTTP ' + r.status);
    }
    return r.body.response;
  });
}

function metadata(id) {
  return playpex.http.request({ url: 'https://archive.org/metadata/' + encodeURIComponent(id), responseType: 'json' }).then(function (r) {
    return r.status === 200 && r.body && r.body.files ? r.body : null;
  }, function () { return null; });
}

// the files worth offering: real videos, the sharpest h.264 first, then by size
function filesOf(meta) {
  return meta.files.filter(function (f) {
    return VIDEO.test(f.name) && FORMATS.test(f.format || '') && !/512kb/i.test(f.name + ' ' + f.format) && Number(f.size) > 20e6;
  }).sort(function (a, b) {
    return (Number(b.height) || 0) - (Number(a.height) || 0) || Number(b.size) - Number(a.size);
  }).slice(0, FILES_PER_ITEM);
}

function quality(height) {
  var h = Number(height) || 0;
  return h >= 2000 ? '2160p' : h >= 1000 ? '1080p' : h >= 700 ? '720p' : h > 0 ? 'SD' : undefined;
}

// keywords → the films' files, each with what it is
function films(query, page, year) {
  return search(query, page, year).then(function (found) {
    var docs = found.docs || [];
    return Promise.all(docs.map(function (doc) {
      return metadata(doc.identifier).then(function (meta) {
        if (!meta) {
          return [];
        }
        var title = String(doc.title || meta.metadata.title || doc.identifier).slice(0, 200),
          year = parseInt(doc.year || meta.metadata.year, 10);
        return filesOf(meta).map(function (f) {
          var ext = f.name.split('.').pop().toLowerCase(),
            result = {
              title: title,
              poster: 'https://archive.org/services/img/' + encodeURIComponent(doc.identifier),
              source: {
                kind: 'http',
                url: 'https://archive.org/download/' + encodeURIComponent(doc.identifier) + '/' + f.name.split('/').map(encodeURIComponent).join('/'),
                label: f.name.split('/').pop(),
                size: Number(f.size) || undefined,
                container: ext,
                codec: /h\.264/i.test(f.format) ? 'h264' : undefined,
                quality: quality(f.height)
              }
            };
          if (year >= 1870 && year <= 2100) {
            result.year = year;
          }
          return result;
        });
      });
    })).then(function (lists) {
      return { results: [].concat.apply([], lists), last: (found.start || 0) + docs.length >= (found.numFound || 0) };
    });
  });
}

playpex.hooks.on('sources.search', function (input) {
  if (input.kind === 'show' || !words(input.query).length) {
    return { results: [], last: true };
  }
  return films(input.query, input.page);
});

// Play: a movie's films by its title and year (the year narrows it to that film)
playpex.hooks.on('play.collect', function (input) {
  var t = input.title;
  if (t.kind !== 'movie' || !words(t.title).length) {
    return [];
  }
  return films(t.title, 1, t.year).then(function (found) {
    return found.results.filter(function (r) { return !t.year || !r.year || r.year === t.year; }).slice(0, 6).map(function (r) {
      return r.source;
    });
  });
});
