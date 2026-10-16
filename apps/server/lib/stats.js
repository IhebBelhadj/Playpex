'use strict';

module.exports = function stats(torrent) {
  var swarm = torrent.swarm;
  // Before metadata arrives there is no torrent.torrent (and no length) yet
  var eta = torrent.torrent ? (torrent.torrent.length - swarm.downloaded) / swarm.downloadSpeed() : null;
  return {
    metadata: !!torrent.torrent,
    peers: {
      total: swarm.wires.length,
      unchocked: swarm.wires.reduce(function (prev, wire) {
        return prev + !wire.peerChoking;
      }, 0)
    },
    traffic: {
      down: swarm.downloaded,
      up: swarm.uploaded
    },
    speed: {
      down: swarm.downloadSpeed(),
      up: swarm.uploadSpeed()
    },
    eta: eta === null || !isFinite(eta) ? null : Math.round(eta),
    queue: swarm.queued,
    paused: swarm.paused
  };
};
