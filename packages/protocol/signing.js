'use strict';

// Signatures of plugin packages and repository indexes (docs/plugins-plan.md
// §6): ed25519 over the exact bytes, keys written `ed25519:<base64 of the 32
// raw bytes>`, signatures as base64. Node only (node:crypto), like mdns.js:
// the server checks, the packaging tools sign; clients never need it.

var crypto = require('crypto');

var PREFIX = 'ed25519:',
  // DER prefixes of a raw ed25519 key in SPKI (public) / PKCS#8 (private) form
  SPKI = Buffer.from('302a300506032b6570032100', 'hex'),
  PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');

function rawKey(key) {
  if (typeof key !== 'string' || key.indexOf(PREFIX) !== 0) {
    throw new Error('not an ed25519: key');
  }
  var raw = Buffer.from(key.slice(PREFIX.length), 'base64');
  if (raw.length !== 32) {
    throw new Error('an ed25519 key is 32 bytes');
  }
  return raw;
}

/** `ed25519:…` → a KeyObject (throws on a malformed key) */
function publicKey(key) {
  return crypto.createPublicKey({ key: Buffer.concat([SPKI, rawKey(key)]), format: 'der', type: 'spki' });
}

/** Whether `signature` (base64) is `key`'s signature of `bytes`; false on any malformed input */
function verify(bytes, signature, key) {
  try {
    var sig = Buffer.from(String(signature).trim(), 'base64');
    return sig.length === 64 && crypto.verify(null, Buffer.from(bytes), publicKey(key), sig);
  } catch (e) {
    return false;
  }
}

/** A new key pair: { publicKey: 'ed25519:…', privateKey: 'ed25519:…' (the 32-byte seed) } */
function generate() {
  var pair = crypto.generateKeyPairSync('ed25519'),
    pub = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI.length),
    priv = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8.length);
  return { publicKey: PREFIX + pub.toString('base64'), privateKey: PREFIX + priv.toString('base64') };
}

/** The base64 signature of `bytes` by a private key from generate() */
function sign(bytes, privateKey) {
  var key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8, rawKey(privateKey)]), format: 'der', type: 'pkcs8' });
  return crypto.sign(null, Buffer.from(bytes), key).toString('base64');
}

/**
 * What a package's `signature` file signs (docs/plugins/README.md): one line
 * per file but `signature` itself, sorted by path, `<sha256 hex>  <path>\n`
 * (paths `/`-separated, relative to the package root), as UTF-8 bytes.
 * @param {Array<{ path: string, bytes: Uint8Array }>} files
 */
function packageDigest(files) {
  return Buffer.from(files.filter(function (f) { return f.path !== 'signature'; })
    .map(function (f) { return { path: f.path, hash: crypto.createHash('sha256').update(f.bytes).digest('hex') }; })
    .sort(function (a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; })
    .map(function (f) { return f.hash + '  ' + f.path + '\n'; }).join(''), 'utf8');
}

/**
 * The `signature` file of a package: JSON { key: <public key>, signature: <base64> }
 * @param {Array<{ path: string, bytes: Uint8Array }>} files
 * @param {{ publicKey: string, privateKey: string }} pair
 */
function signPackage(files, pair) {
  return JSON.stringify({ key: pair.publicKey, signature: sign(packageDigest(files), pair.privateKey) }, null, 2) + '\n';
}

/**
 * Who signed a package: the key of its valid `signature` file, else null
 * (none, malformed, or not matching the files).
 * @param {Array<{ path: string, bytes: Uint8Array }>} files every file, `signature` included
 */
function packageSigner(files) {
  var file = files.filter(function (f) { return f.path === 'signature'; })[0], parsed;
  if (!file) {
    return null;
  }
  try {
    parsed = JSON.parse(Buffer.from(file.bytes).toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!parsed || typeof parsed.key !== 'string' || typeof parsed.signature !== 'string') {
    return null;
  }
  return verify(packageDigest(files), parsed.signature, parsed.key) ? parsed.key : null;
}

/** A short form of a key for people to compare: 8 groups of 4 hex of its sha256 */
function fingerprint(key) {
  var hex = crypto.createHash('sha256').update(rawKey(key)).digest('hex').slice(0, 32);
  return hex.match(/.{4}/g).join(' ');
}

module.exports = {
  verify: verify,
  sign: sign,
  generate: generate,
  fingerprint: fingerprint,
  publicKey: publicKey,
  packageDigest: packageDigest,
  signPackage: signPackage,
  packageSigner: packageSigner
};
