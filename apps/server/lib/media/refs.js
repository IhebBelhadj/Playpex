'use strict';

// Media refs (docs/media-server-plan.md §3): the id the media routes take.
//   t_<infoHash>_<pathHash>   a file of a torrent; pathHash = the first 16 hex
//                             of the SHA-1 of its path in the torrent
//   f_<fileId>                a file of the library (media_files.id, a UUID)
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

// { kind: 'torrent', infoHash, pathHash } | { kind: 'file', id } | null
function parse(ref) {
  if (typeof ref !== 'string' || !PATTERN.test(ref)) {
    return null;
  }
  return ref[0] === 't' ? { kind: 'torrent', infoHash: ref.slice(2, 42), pathHash: ref.slice(43) } :
    { kind: 'file', id: ref.slice(2) };
}

module.exports = {
  torrent: torrent,
  file: file,
  parse: parse,
  pathHash: pathHash
};
