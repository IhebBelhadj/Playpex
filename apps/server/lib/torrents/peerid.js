'use strict';

// A peer's client from its peer id (the dashboard's Peers tab), when the
// engine doesn't know its own name for it: Azureus-style ids (`-qB4630-…` →
// "qBittorrent 4.6.3") and Mainline-style ones (`M7-4-3--…` → "BitTorrent
// 7.4.3"). Engine-neutral: ids arrive as hex from any adapter.

var AZUREUS = {
  qB: 'qBittorrent', UT: 'µTorrent', UM: 'µTorrent Mac', UW: 'µTorrent Web', TR: 'Transmission', DE: 'Deluge',
  LT: 'libtorrent', lt: 'rTorrent', AZ: 'Vuze', BI: 'BiglyBT', WW: 'WebTorrent', WD: 'WebTorrent Desktop',
  BT: 'BitTorrent', BW: 'BitTorrent Web', TX: 'Tixati', FD: 'Free Download Manager', KT: 'KTorrent', A2: 'aria2',
  BC: 'BitComet', XL: 'Xunlei', SD: 'Thunder', PI: 'PicoTorrent', FW: 'FrostWire', FX: 'Flashget', TS: 'torrent-stream',
  PD: 'Playpex torrentd', BF: 'BitFlu', HL: 'Halite', LW: 'LimeWire', MG: 'MediaGet', TT: 'TuoTu', VG: 'Vagaa',
  RT: 'Retriever', XF: 'Xfplay', 'AG': 'Ares', SZ: 'Shareaza', ZT: 'ZipTorrent', st: 'SharkTorrent', BN: 'Baidu Netdisk'
};

// "4630" → "4.6.3"; "355W" → "3.5.5"
function version(chars) {
  var parts = chars.replace(/[^0-9A-Za-z]/g, '').split('').filter(function (c) { return /[0-9]/.test(c); });
  while (parts.length > 1 && parts[parts.length - 1] === '0') {
    parts.pop();
  }
  return parts.join('.');
}

/** @param {string|null} hex  the 20-byte peer id as hex @returns {string|null} */
function clientOf(hex) {
  if (!hex || !/^[0-9a-f]{40}$/i.test(hex)) {
    return null;
  }
  var id = Buffer.from(hex, 'hex').toString('latin1'), m = /^-([A-Za-z0-9~]{2})([0-9A-Za-z]{4})-/.exec(id);
  if (m) {
    var name = AZUREUS[m[1]];
    return name ? (name + ' ' + version(m[2])).trim() : 'Unknown (' + m[1] + ')';
  }
  m = /^([MQ])(\d+)-(\d+)-(\d+)-/.exec(id);
  if (m) {
    return (m[1] === 'M' ? 'BitTorrent' : 'Queen Bee') + ' ' + [m[2], m[3], m[4]].join('.');
  }
  return null;
}

module.exports = { clientOf: clientOf };
