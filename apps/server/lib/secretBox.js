'use strict';

// Values kept encrypted in playpex.db (plugins' secrets and linked accounts'
// tokens, `plugin_secrets`): AES-256-GCM with a key of its own in
// <config>/secrets.key (32 random bytes, 0600, made on first use), so a copy
// of the database (a backup, a file shared to get help) holds no API key or
// account token anyone can use. The key stays on this machine: whoever reads
// the config folder reads both, as with auth.json.
//
//   seal(text)  → 'enc:v1:<iv>.<tag>.<ciphertext>' (base64url)
//   open(value) → the text; a value without the prefix (written before this
//                 existed) is answered as it is; one that doesn't decrypt
//                 (another key) → null, logged once
//   sealed(value) → whether it is already encrypted
//   createBox(key) for tests (a key Buffer, no file)

var crypto = require('crypto'),
  fs = require('fs'),
  path = require('path');

var PREFIX = 'enc:v1:';

function b64(buf) {
  return buf.toString('base64url');
}

function createBox(getKey, onFailure) {
  function seal(text) {
    if (text === null || text === undefined) {
      return text;
    }
    var iv = crypto.randomBytes(12),
      cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv),
      body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    return PREFIX + b64(iv) + '.' + b64(cipher.getAuthTag()) + '.' + b64(body);
  }

  function open(value) {
    if (typeof value !== 'string' || value.indexOf(PREFIX) !== 0) {
      return value === undefined ? null : value;
    }
    var parts = value.slice(PREFIX.length).split('.');
    try {
      var decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(parts[0], 'base64url'));
      decipher.setAuthTag(Buffer.from(parts[1], 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]).toString('utf8');
    } catch (e) {
      if (onFailure) {
        onFailure(e);
      }
      return null;
    }
  }

  return {
    seal: seal,
    open: open,
    sealed: function (value) { return typeof value === 'string' && value.indexOf(PREFIX) === 0; }
  };
}

// The server's box: its key read (or made) the first time a value is sealed or opened
var key = null,
  warned = false;

function keyFile() {
  return path.join(require('./paths').config, 'secrets.key');
}

function serverKey() {
  if (key) {
    return key;
  }
  var file = keyFile();
  try {
    var text = fs.readFileSync(file, 'utf8').trim(),
      buf = Buffer.from(text, 'base64');
    if (buf.length === 32) {
      key = buf;
      return key;
    }
    throw new Error('secrets.key is not a 32-byte key');
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // never replace a key that exists: the values sealed with it would be lost
      throw e;
    }
  }
  var made = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, made.toString('base64') + '\n', { mode: 384, flag: 'wx' });   // 0600, never over another
  key = made;
  return key;
}

var server = createBox(serverKey, function () {
  if (!warned) {
    warned = true;
    require('./logger').child('plugins').warn('a stored secret doesn\'t decrypt with secrets.key (was the key replaced?): treated as not set');
  }
});

module.exports = {
  seal: server.seal,
  open: server.open,
  sealed: server.sealed,
  createBox: function (k) { return createBox(function () { return k; }); },
  PREFIX: PREFIX
};
