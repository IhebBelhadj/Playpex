// Types of signing.js (Node only): ed25519 signatures of plugin packages and repository indexes.

import type { KeyObject } from 'crypto';

/** Whether `signature` (base64) is `key`'s (`ed25519:…`) signature of `bytes`; false on malformed input */
export declare function verify(bytes: Uint8Array | string, signature: string, key: string): boolean;
/** The base64 signature of `bytes` by a private key from generate() */
export declare function sign(bytes: Uint8Array | string, privateKey: string): string;
export declare function generate(): { publicKey: string; privateKey: string };
/** 8 groups of 4 hex of the key's sha256, for people to compare */
export declare function fingerprint(key: string): string;
export declare function publicKey(key: string): KeyObject;

export interface PackageFile { path: string; bytes: Uint8Array; }
/** What a package's `signature` signs: `<sha256 hex>  <path>\n` per file but `signature`, sorted by path */
export declare function packageDigest(files: PackageFile[]): Buffer;
/** The `signature` file's text: { key, signature } as JSON */
export declare function signPackage(files: PackageFile[], pair: { publicKey: string; privateKey: string }): string;
/** The key of a package's valid `signature`, else null */
export declare function packageSigner(files: PackageFile[]): string | null;
