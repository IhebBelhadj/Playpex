'use strict';

// Public trackers added to every episode magnet. HTTP(S) ones are included
// for networks that block UDP.
var TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.qu.ax:6969/announce',
  'udp://open.dstud.io:6969/announce',
  'http://tracker.opentrackr.org:1337/announce',
  'https://tracker.moeblog.cn:443/announce',
  'https://tracker.zhuqiy.com:443/announce'
];

function parse(magnet) {
  var query = String(magnet).split('?')[1] || '';
  var params = new URLSearchParams(query);
  return { name: params.get('dn'), trackers: params.getAll('tr') };
}

// One magnet for `hash` carrying every tracker from `magnets` plus the defaults
function build(hash, name, magnets) {
  var trackers = [];
  (magnets || []).forEach(function (magnet) {
    parse(magnet).trackers.forEach(function (tr) {
      if (trackers.indexOf(tr) === -1) {
        trackers.push(tr);
      }
    });
  });
  TRACKERS.forEach(function (tr) {
    if (trackers.indexOf(tr) === -1) {
      trackers.push(tr);
    }
  });

  return 'magnet:?xt=urn:btih:' + hash +
    (name ? '&dn=' + encodeURIComponent(name) : '') +
    trackers.map(function (tr) { return '&tr=' + encodeURIComponent(tr); }).join('');
}

module.exports = {
  list: TRACKERS,
  build: build
};
