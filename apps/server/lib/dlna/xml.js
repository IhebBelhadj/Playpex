'use strict';

// XML of the DLNA server (lib/dlna): escaping, SOAP envelopes and faults,
// reading a SOAP request's action and arguments, DIDL-Lite. UPnP control
// messages are flat (an action element holding text-only arguments), so a
// small tolerant reader is enough; no XML library.

var NS = {
  soap: 'http://schemas.xmlsoap.org/soap/envelope/',
  encoding: 'http://schemas.xmlsoap.org/soap/encoding/',
  control: 'urn:schemas-upnp-org:control-1-0',
  didl: 'urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/',
  dc: 'http://purl.org/dc/elements/1.1/',
  upnp: 'urn:schemas-upnp-org:metadata-1-0/upnp/',
  dlna: 'urn:schemas-dlna-org:metadata-1-0/',
  sec: 'http://www.sec.co.kr/'
};

function escape(value) {
  return String(value === null || value === undefined ? '' : value)
    // characters XML 1.0 can't hold at all (control characters in file names)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function unescape(text) {
  return String(text).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, function (all, cdata) {
    return cdata;
  }).replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, function (all, entity) {
    var e = entity.toLowerCase();
    if (e[0] === '#') {
      var code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e];
  });
}

// <name>value</name> for each [name, value]
function elements(pairs) {
  return pairs.map(function (pair) {
    return '<' + pair[0] + '>' + escape(pair[1]) + '</' + pair[0] + '>';
  }).join('');
}

function envelope(body) {
  return '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<s:Envelope xmlns:s="' + NS.soap + '" s:encodingStyle="' + NS.encoding + '"><s:Body>' + body +
    '</s:Body></s:Envelope>';
}

// The answer of `action` of service `serviceType`: [[name, value], …] out arguments
function response(serviceType, action, args) {
  return envelope('<u:' + action + 'Response xmlns:u="' + serviceType + '">' + elements(args || []) +
    '</u:' + action + 'Response>');
}

// UPnP errors (UPnP Device Architecture §3.2.2, ContentDirectory §2.5.4)
var ERRORS = {
  401: 'Invalid Action',
  402: 'Invalid Args',
  501: 'Action Failed',
  701: 'No such object',
  709: 'Unsupported or invalid sort criteria',
  720: 'Cannot process the request'
};

function fault(code) {
  return envelope('<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail>' +
    '<UPnPError xmlns="' + NS.control + '"><errorCode>' + code + '</errorCode><errorDescription>' +
    escape(ERRORS[code] || 'Error') + '</errorDescription></UPnPError></detail></s:Fault>');
}

/**
 * The action of a SOAP request: its name (from the SOAPACTION header
 * `"<serviceType>#<action>"`, else the Body's first element) and its
 * arguments (text of the action element's children), or null.
 * @returns {{ service: string|null, action: string, args: Object<string, string> }|null}
 */
function parseAction(soapAction, body) {
  var header = /^"?([^"#]*)#([A-Za-z_][\w.-]*)"?$/.exec(String(soapAction || '').trim()),
    text = String(body || ''),
    inBody = /<(?:[\w.-]+:)?Body\b[^>]*>\s*<(?:([\w.-]+):)?([A-Za-z_][\w.-]*)\b([^>]*?)(\/?)>([\s\S]*)$/.exec(text),
    action = header ? header[2] : inBody && inBody[2];
  if (!action) {
    return null;
  }
  var args = {};
  if (inBody && inBody[4] !== '/') {
    var prefix = inBody[1] ? inBody[1] + ':' : '',
      end = inBody[5].indexOf('</' + prefix + inBody[2]),
      inner = end === -1 ? inBody[5] : inBody[5].slice(0, end),
      arg = /<(?:[\w.-]+:)?([A-Za-z_][\w.-]*)\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?\1\s*>)/g,
      m;
    while ((m = arg.exec(inner))) {
      args[m[1]] = m[2] === undefined ? '' : unescape(m[2]).trim();
    }
  }
  return { service: header ? header[1] : null, action: action, args: args };
}

// H:MM:SS.mmm (DLNA's res@duration)
function duration(seconds) {
  if (!(seconds > 0)) {
    return null;
  }
  var ms = Math.round(seconds * 1000),
    h = Math.floor(ms / 3600000),
    m = Math.floor(ms % 3600000 / 60000),
    s = Math.floor(ms % 60000 / 1000);
  return h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s + '.' + String(ms % 1000).padStart(3, '0');
}

function attrs(obj) {
  return Object.keys(obj).filter(function (k) {
    return obj[k] !== null && obj[k] !== undefined && obj[k] !== '';
  }).map(function (k) {
    return ' ' + k + '="' + escape(obj[k]) + '"';
  }).join('');
}

/**
 * DIDL-Lite of containers and items (lib/dlna/tree.js objects, with URLs
 * made absolute by the caller):
 *   container { id, parentId, title, childCount, art? }
 *   item { id, parentId, title, upnpClass, date?, episode?, season?, art?,
 *          res: { url, protocolInfo, size, duration, resolution },
 *          subtitles: [{ url, type: 'srt' }] }
 */
function didl(objects) {
  return '<DIDL-Lite xmlns="' + NS.didl + '" xmlns:dc="' + NS.dc + '" xmlns:upnp="' + NS.upnp +
    '" xmlns:dlna="' + NS.dlna + '" xmlns:sec="' + NS.sec + '">' + objects.map(function (o) {
    var art = o.art ? '<upnp:albumArtURI dlna:profileID="JPEG_TN">' + escape(o.art) + '</upnp:albumArtURI>' : '';
    if (o.container) {
      return '<container' + attrs({ id: o.id, parentID: o.parentId, restricted: '1', searchable: '0', childCount: o.childCount }) +
        '><dc:title>' + escape(o.title) + '</dc:title><upnp:class>object.container.storageFolder</upnp:class>' + art + '</container>';
    }
    var res = o.res;
    return '<item' + attrs({ id: o.id, parentID: o.parentId, restricted: '1' }) + '>' +
      '<dc:title>' + escape(o.title) + '</dc:title><upnp:class>' + o.upnpClass + '</upnp:class>' +
      (o.date ? '<dc:date>' + escape(o.date) + '</dc:date>' : '') +
      (o.season !== undefined && o.season !== null ? '<upnp:episodeSeason>' + o.season + '</upnp:episodeSeason>' : '') +
      (o.episode ? '<upnp:episodeNumber>' + o.episode + '</upnp:episodeNumber>' : '') +
      art +
      (o.subtitles || []).map(function (sub) {
        // Samsung reads sec:CaptionInfoEx, others a res of the subtitle's type
        return '<sec:CaptionInfoEx sec:type="' + sub.type + '">' + escape(sub.url) + '</sec:CaptionInfoEx>';
      }).join('') +
      '<res' + attrs({ protocolInfo: res.protocolInfo, size: res.size, duration: duration(res.duration), resolution: res.resolution }) +
      '>' + escape(res.url) + '</res>' +
      (o.subtitles || []).map(function (sub) {
        return '<res protocolInfo="http-get:*:text/' + sub.type + ':*">' + escape(sub.url) + '</res>';
      }).join('') +
      '</item>';
  }).join('') + '</DIDL-Lite>';
}

module.exports = {
  NS: NS,
  escape: escape,
  unescape: unescape,
  elements: elements,
  response: response,
  fault: fault,
  parseAction: parseAction,
  duration: duration,
  didl: didl
};
