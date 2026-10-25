'use strict';

// Media refs (docs/media-server-plan.md §3): the id the media routes take.
//   t_<infoHash>_<pathHash>   a file of a torrent; pathHash = the first 16 hex
//                             of the SHA-1 of its path in the torrent
//   f_<fileId>                a file of the library (media_files.id, a UUID)
//   r_<32 hex>                a plugin's HTTPS source, proxied by the server
//                             (lib/plugins/remote.js; random, kept in memory)
//   h_<32 hex>                a plugin's HLS stream (lib/media/hls.js: a
//                             playlist proxied, its URIs rewritten)
//   l_<32 hex>                a plugin's continuous live stream (lib/media/hls.js:
//                             remuxed by ffmpeg)
// Opaque to clients (the pattern is @playpex/protocol MEDIA_REF_PATTERN):
// they get refs from the server (TorrentFile.ref, later the play sources).

var crypto = require('crypto'),
  protocol = require('@playpex/protocol');

var PATTERN = new RegExp(protocol.MEDIA_REF_PATTERN);

function pathHash(filePath) {
  return crypto.createHash('sha1').update(filePath, 'utf8').digest('hex').slice(0, 16);
}

function torrent(infoHash, filePath) {
  return 't_' + infoHash.toLowerCase() + '_' + pathHash(filePath);
}

function file(id) {
  return 'f_' + id;
}

function remote(id) {
  return 'r_' + id;
}

function hls(id) {
  return 'h_' + id;
}

function live(id) {
  return 'l_' + id;
}

var KINDS = { f: 'file', r: 'remote', h: 'hls', l: 'live' };

// { kind: 'torrent', infoHash, pathHash } | { kind: 'file' | 'remote' | 'hls' | 'live', id } | null
function parse(ref) {
  if (typeof ref !== 'string' || !PATTERN.test(ref)) {
    return null;
  }
  return ref[0] === 't' ? { kind: 'torrent', infoHash: ref.slice(2, 42), pathHash: ref.slice(43) } :
    { kind: KINDS[ref[0]], id: ref.slice(2) };
}

module.exports = {
  torrent: torrent,
  file: file,
  remote: remote,
  hls: hls,
  live: live,
  parse: parse,
  pathHash: pathHash
};
