'use strict';

// The torrent engine port (docs/media-server-plan.md §4.3): what an engine
// adapter (lib/torrents/engines/*) offers the torrent client
// (lib/torrents/client.js), the only module that uses one. Types and
// constants only; the adapters hold the code.
//
// Engine-neutral by rule: torrents are info hashes (lowercase hex), files are
// their path inside the torrent, states are the names below. No engine
// object, id, stream class, error type or option crosses the port. Everything
// needed to add a torrent again (metainfo, selection, save path) is ours (the
// `downloads` table and <config>/torrents/<hash>.torrent): an engine's own
// session data is only a cache.
//
// Every method answers a Promise, and rejects with an EngineError
// (./errors.js) for expected failures.

var ENGINE_PORT_VERSION = 1;

// What an adapter declares it can do; the client reads these, never the
// engine's id
var CAPABILITIES = {
  fastResume: 'existing data is not re-checked when a torrent starts again (else: state checking)',
  pause: 'a real pause: no peers, no traffic, the torrent stays in the engine (else: stop + add again)',
  rateLimits: 'download / upload speed limits (setLimits)',
  fileSelection: 'per-file selection (select); else every file is downloaded',
  streamPriority: 'stream() prioritises the pieces being read',
  persistentSession: 'the engine remembers its torrents across its own restarts (list() after init)'
};

// What stats() reports for a torrent the engine holds
var ENGINE_STATES = ['checking', 'downloading', 'seeding', 'paused', 'error'];

/**
 * @typedef {object} EngineInit
 * @property {string} dataDir      default save path
 * @property {string} stateDir     where the engine may keep its own cache / session
 * @property {number} [peerPort]   BitTorrent port; 0 = any free port; taken → another one
 * @property {boolean} [portForwarding]  ask the router to forward it (UPnP), where the engine can
 * @property {boolean} [discovery] false: no DHT, trackers or local discovery (tests: peers given to add())
 * @property {{ downBps?: number, upBps?: number, uploadSlots?: number }} [limits]
 * @property {object} log          a lib/logger child
 *
 * @typedef {object} AddRequest
 * @property {string} infoHash
 * @property {string} [magnet]
 * @property {Buffer} [torrentFile]  the .torrent (metainfo); with it no metadata exchange is needed
 * @property {string} savePath       files go to <savePath>/<path inside the torrent>
 * @property {string[]|null} [files] paths to download; null / missing = every file
 * @property {boolean} [onlyLargest]  with no files: only the largest one (a stream before its
 *                                   player chose); engines that list files before downloading
 *                                   apply it from the first byte
 * @property {boolean} [paused]      known to the engine, not running
 * @property {string[]} [trackers]   announce URLs added to the torrent's own
 * @property {string[]} [peers]      'host:port' to connect to (tests, LAN)
 *
 * @typedef {object} Metadata
 * @property {string} name
 * @property {number} length         bytes
 * @property {number} pieceLength
 * @property {{ path: string, size: number, offset: number }[]} files
 * @property {Buffer} torrentFile    a .torrent of this torrent (info dictionary + announce list)
 *
 * @typedef {object} TorrentStats
 * @property {string} state          one of ENGINE_STATES
 * @property {boolean} metadata      the metadata is known
 * @property {number} doneBytes      of the selected files, verified
 * @property {number|null} sizeBytes of the selected files; null without metadata
 * @property {number} downBps
 * @property {number} upBps
 * @property {number} peers          connected
 * @property {number} peersUnchoked  connected peers that send to us
 * @property {number} seeds          connected peers that have everything
 * @property {number} downloadedBytes counters since the engine got the torrent (may restart at 0)
 * @property {number} uploadedBytes
 * @property {{ done: number, total: number }|null} checking   progress of a check
 * @property {Uint8Array|null} pieces 1 per verified piece; null when unknown
 * @property {string|null} [error]   with state 'error': why
 *
 * @typedef {object} Engine
 * @property {string} id
 * @property {Object<string, boolean>} capabilities  keys of CAPABILITIES
 * @property {function(EngineInit): Promise<void>} init
 * @property {function(): Promise<void>} close                  every torrent stopped, data kept
 * @property {function(): Promise<{ ok: boolean, detail: string|null }>} health
 * @property {function(AddRequest): Promise<{ infoHash: string, name: string|null }>} add   idempotent
 * @property {function(string): Promise<Metadata>} metadata     NO_METADATA_YET before it arrived
 * @property {function(string): Promise<void>} start
 * @property {function(string): Promise<void>} pause            UNSUPPORTED without the capability
 * @property {function(string): Promise<void>} stop             the engine forgets it, data kept
 * @property {function(string, { deleteData: boolean }): Promise<void>} remove
 * @property {function(string, string[]|null): Promise<void>} select   null = every file
 * @property {function(): Promise<Map<string, TorrentStats>>} stats   one call for every torrent
 * @property {function(string, string, { start?: number, end?: number }): Promise<import('stream').Readable>} stream
 *   the bytes of that range (inclusive end), waiting for the engine to be ready; prioritised
 * @property {function({ downBps?: number, upBps?: number, uploadSlots?: number }): Promise<void>} setLimits
 * @property {function(): Promise<string[]>} list               hashes the engine has now
 * @property {function(string, function): void} on              'metadata' (hash), 'done' (hash), 'error' (hash, EngineError)
 */

module.exports = {
  ENGINE_PORT_VERSION: ENGINE_PORT_VERSION,
  CAPABILITIES: CAPABILITIES,
  ENGINE_STATES: ENGINE_STATES
};
