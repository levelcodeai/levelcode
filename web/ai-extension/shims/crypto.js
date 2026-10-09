// `crypto` for the browser build: the three things the extension uses.
//
//   randomBytes(n)                         from the platform CSPRNG
//   randomUUID()
//   createHash('sha256').update(x).digest(enc)   SYNCHRONOUS, which WebCrypto is not, so the digest is
//                                                computed here (FIPS 180-4). PKCE (extension.js) and the
//                                                image store both need it inline.
'use strict';
const { Buffer } = require('buffer');

const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

class Sha256 {
	constructor() {
		this.h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
		this.block = new Uint8Array(64);
		this.blockLen = 0;
		this.total = 0;
		this.w = new Uint32Array(64);
		this.done = false;
	}
	update(data, encoding) {
		if (this.done) { throw new Error('Digest already called'); }
		const bytes = typeof data === 'string' ? Buffer.from(data, encoding || 'utf8') : data;
		for (let i = 0; i < bytes.length; i++) {
			this.block[this.blockLen++] = bytes[i];
			if (this.blockLen === 64) { this.compress(); this.blockLen = 0; }
		}
		this.total += bytes.length;
		return this;
	}
	compress() {
		const w = this.w;
		const b = this.block;
		for (let i = 0; i < 16; i++) { w[i] = (b[i * 4] << 24) | (b[i * 4 + 1] << 16) | (b[i * 4 + 2] << 8) | b[i * 4 + 3]; }
		for (let i = 16; i < 64; i++) {
			const a = w[i - 15], c = w[i - 2];
			const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
			const s1 = ((c >>> 17) | (c << 15)) ^ ((c >>> 19) | (c << 13)) ^ (c >>> 10);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
		}
		let [a, b2, c, d, e, f, g, h] = this.h;
		for (let i = 0; i < 64; i++) {
			const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
			const ch = (e & f) ^ (~e & g);
			const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
			const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
			const maj = (a & b2) ^ (a & c) ^ (b2 & c);
			const t2 = (S0 + maj) | 0;
			h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b2; b2 = a; a = (t1 + t2) | 0;
		}
		const H = this.h;
		H[0] = (H[0] + a) | 0; H[1] = (H[1] + b2) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
		H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
	}
	digest(encoding) {
		if (this.done) { throw new Error('Digest already called'); }
		this.done = true;
		const bitLen = this.total * 8;
		this.block[this.blockLen++] = 0x80;
		if (this.blockLen > 56) {
			this.block.fill(0, this.blockLen);
			this.compress();
			this.blockLen = 0;
		}
		this.block.fill(0, this.blockLen, 56);
		const hi = Math.floor(bitLen / 0x100000000);
		const lo = bitLen >>> 0;
		for (let i = 0; i < 4; i++) { this.block[56 + i] = (hi >>> (24 - i * 8)) & 0xff; this.block[60 + i] = (lo >>> (24 - i * 8)) & 0xff; }
		this.compress();
		const out = Buffer.alloc(32);
		for (let i = 0; i < 8; i++) { out.writeUInt32BE(this.h[i] >>> 0, i * 4); }
		return encoding ? out.toString(encoding) : out;
	}
}

function createHash(algorithm) {
	const name = String(algorithm).toLowerCase();
	if (name !== 'sha256') {
		const e = new Error('Digest method not supported: ' + algorithm);
		e.code = 'ERR_CRYPTO_INVALID_DIGEST';
		throw e;
	}
	return new Sha256();
}

function randomBytes(size) {
	const out = Buffer.alloc(size);
	globalThis.crypto.getRandomValues(out);
	return out;
}

function randomUUID() { return globalThis.crypto.randomUUID(); }

module.exports = { createHash, randomBytes, randomUUID };
