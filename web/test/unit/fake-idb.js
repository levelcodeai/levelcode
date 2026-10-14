/*---------------------------------------------------------------------------------------------
 *  A small in-memory IndexedDB for the unit suites (not a suite itself: the gate runs *.test.js).
 *
 *  Only what the page and the scratch workspace use — open with an upgrade, object stores with a key path or
 *  out-of-line keys, get / put / add / delete / getAll / getAllKeys over IDBKeyRange.bound, transactions that
 *  commit when they have nothing left to do and can be aborted. What matters for the tests is the one rule real
 *  browsers keep: readwrite transactions on a store run one at a time, and a readonly one reads what is committed.
 *  Requests answer asynchronously, and a transaction stays open while a request's answer is being handled.
 *--------------------------------------------------------------------------------------------*/
'use strict';

const later = (fn) => setTimeout(fn, 0);

class KeyRange {
	constructor(lower, upper) { this.lower = lower; this.upper = upper; }
	static bound(lower, upper) { return new KeyRange(lower, upper); }
	includes(k) { return k >= this.lower && k <= this.upper; }
}

function createIndexedDB() {
	/** name -> { version, stores: Map<name, { keyPath, data: Map }>, queue: Promise } */
	const dbs = new Map();
	const open = (name, version) => {
		const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
		later(() => {
			let rec = dbs.get(name);
			const fresh = !rec;
			if (!rec) { rec = { version: 0, stores: new Map(), tail: Promise.resolve() }; dbs.set(name, rec); }
			req.result = makeDb(rec);
			if (fresh || version > rec.version) { rec.version = version || 1; if (req.onupgradeneeded) { req.onupgradeneeded({ target: req }); } }
			if (req.onsuccess) { req.onsuccess({ target: req }); }
		});
		return req;
	};
	const makeDb = (rec) => ({
		createObjectStore(store, opts) { rec.stores.set(store, { keyPath: opts && opts.keyPath, data: new Map() }); return {}; },
		close() { },
		transaction(storeName, mode = 'readonly') { return makeTx(rec, storeName, mode); },
	});
	const makeTx = (rec, storeName, mode) => {
		const meta = rec.stores.get(storeName);
		if (!meta) { throw new Error('NotFoundError: ' + storeName); }
		// Readwrite transactions wait for the one before them; a readonly one starts at once.
		let release;
		const turn = mode === 'readwrite' ? rec.tail : Promise.resolve();
		if (mode === 'readwrite') { rec.tail = new Promise((r) => { release = r; }); }
		let writes = null;   // this transaction's view, taken when it STARTS (after the one before it); committed on complete
		let started = false, pending = 0, finished = false;
		const queued = [];
		const tx = { oncomplete: null, onerror: null, onabort: null, error: null,
			objectStore() { return store; },
			abort() { if (finished) { return; } finished = true; later(() => { if (tx.onabort) { tx.onabort({ target: tx }); } if (release) { release(); } }); },
		};
		const settle = () => {
			later(() => {
				if (finished || pending > 0) { return; }
				finished = true;
				if (mode === 'readwrite') { meta.data.clear(); for (const [k, v] of writes) { meta.data.set(k, v); } }
				if (tx.oncomplete) { tx.oncomplete({ target: tx }); }
				if (release) { release(); }
			});
		};
		const run = (op) => {
			const req = { result: undefined, error: null, onsuccess: null, onerror: null };
			pending++;
			const go = () => later(() => {
				if (finished) { pending--; return; }
				try { req.result = op(); } catch (e) { req.error = e; }
				if (req.error) { if (req.onerror) { req.onerror({ target: req }); } tx.error = req.error; finished = true; if (tx.onerror) { tx.onerror({ target: tx }); } if (release) { release(); } pending--; return; }
				if (req.onsuccess) { req.onsuccess({ target: req }); }
				// A request made while this answer is handled — or in the promise continuations it starts — keeps it open.
				Promise.resolve().then(() => Promise.resolve()).then(() => { pending--; settle(); });
			});
			if (started) { go(); } else { queued.push(go); }
			return req;
		};
		turn.then(() => { writes = new Map(meta.data); started = true; for (const go of queued.splice(0)) { go(); } if (queued.length === 0 && pending === 0) { settle(); } });
		const keyOf = (value, key) => (key !== undefined ? key : value[meta.keyPath]);
		const clone = (v) => (v && typeof v === 'object' && !(v instanceof Uint8Array) && !(typeof v.type === 'string' && v.algorithm) ? JSON.parse(JSON.stringify(v, (k, x) => (x instanceof Uint8Array ? { __u8: [...x] } : x)), (k, x) => (x && x.__u8 ? Uint8Array.from(x.__u8) : x)) : v);
		const range = (q) => [...writes.keys()].filter((k) => (q instanceof KeyRange ? q.includes(k) : true)).sort();
		const store = {
			get: (k) => run(() => clone(writes.get(k))),
			put: (v, k) => run(() => { if (mode !== 'readwrite') { throw new Error('ReadOnlyError'); } writes.set(keyOf(v, k), clone(v)); return keyOf(v, k); }),
			add: (v, k) => run(() => { if (mode !== 'readwrite') { throw new Error('ReadOnlyError'); } if (writes.has(keyOf(v, k))) { throw new Error('ConstraintError'); } writes.set(keyOf(v, k), clone(v)); return keyOf(v, k); }),
			delete: (k) => run(() => { if (mode !== 'readwrite') { throw new Error('ReadOnlyError'); } writes.delete(k); }),
			getAll: (q) => run(() => range(q).map((k) => clone(writes.get(k)))),
			getAllKeys: (q) => run(() => range(q)),
		};
		return tx;
	};
	return { indexedDB: { open }, IDBKeyRange: KeyRange };
}

module.exports = { createIndexedDB };
