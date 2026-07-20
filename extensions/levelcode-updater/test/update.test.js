/*---------------------------------------------------------------------------------------------
 *  Unit tests for extensions/levelcode-updater/update.js  —  run: node update.test.js
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const U = require('../update');

let n = 0;
function test(name, fn) { fn(); n++; console.log('  ok - ' + name); }

test('platformTarget maps platform/arch to feed asset ids', () => {
	assert.strictEqual(U.platformTarget('darwin', 'arm64'), 'darwin-arm64');
	assert.strictEqual(U.platformTarget('darwin', 'x64'), 'darwin');
	assert.strictEqual(U.platformTarget('win32', 'x64'), 'win32-x64');
	assert.strictEqual(U.platformTarget('linux', 'arm64'), 'linux-arm64');
});

test('buildFeedUrl assembles /api/update/{target}/{quality}/{commit} and trims trailing slashes', () => {
	assert.strictEqual(
		U.buildFeedUrl('https://x.dev/', 'darwin-arm64', 'stable', 'abc123'),
		'https://x.dev/api/update/darwin-arm64/stable/abc123'
	);
	assert.strictEqual(
		U.buildFeedUrl('http://localhost:9696', 'darwin', 'stable', 'deadbeef'),
		'http://localhost:9696/api/update/darwin/stable/deadbeef'
	);
});

test('parseFeed: 204 → up to date (null)', () => {
	assert.strictEqual(U.parseFeed(204, ''), null);
});

test('parseFeed: 200 + valid JSON with version → the release', () => {
	const feed = U.parseFeed(200, JSON.stringify({ version: 'newsha', productVersion: '0.2.0', url: 'https://x/z.zip' }));
	assert.ok(feed);
	assert.strictEqual(feed.version, 'newsha');
	assert.strictEqual(feed.productVersion, '0.2.0');
});

test('parseFeed: 200 without a version, or bad JSON, or error status → null', () => {
	assert.strictEqual(U.parseFeed(200, JSON.stringify({ productVersion: '0.2.0' })), null); // no version
	assert.strictEqual(U.parseFeed(200, 'not json'), null);
	assert.strictEqual(U.parseFeed(500, 'oops'), null);
	assert.strictEqual(U.parseFeed(0, ''), null);
});

test('isNewer: different commit → true; same → false; missing → false', () => {
	assert.strictEqual(U.isNewer({ version: 'new' }, 'old'), true);
	assert.strictEqual(U.isNewer({ version: 'same' }, 'same'), false);
	assert.strictEqual(U.isNewer(null, 'old'), false);
	assert.strictEqual(U.isNewer({}, 'old'), false);
});

test('releaseLabel prefers productVersion', () => {
	assert.strictEqual(U.releaseLabel({ version: 'x', productVersion: '0.3.0' }), 'LevelCode 0.3.0');
	assert.strictEqual(U.releaseLabel({ version: 'x' }), 'A new LevelCode build');
});

// The regression this guards: before auto-update S2 the feed's `url` was a release PAGE, so opening it
// was fine. S2 made it the arch-matched LevelCode-<arch>.app.zip — an install artifact for Squirrel.
// A notify-only "Download" button must never open that; it would start a raw zip download.
test('downloadUrl NEVER returns feed.url — not even when it is a signed .app.zip', () => {
	const feed = {
		version: 'abc', productVersion: '0.7.3',
		url: 'https://github.com/levelcodeai/levelcode/releases/download/v0.7.3/LevelCode-arm64.app.zip',
		releaseNotesUrl: 'https://github.com/levelcodeai/levelcode/releases/tag/v0.7.3'
	};
	const product = { downloadUrl: 'https://levelcode.ai/download' };
	assert.strictEqual(U.downloadUrl(feed, product, 'https://levelcode.ai'), 'https://levelcode.ai/download');
	// and with no product download funnel configured, it falls back to a PAGE, still never the zip
	assert.strictEqual(U.downloadUrl(feed, {}, 'https://levelcode.ai'), feed.releaseNotesUrl);
	assert.strictEqual(U.downloadUrl(feed, {}, 'https://levelcode.ai').endsWith('.zip'), false);
});

test('downloadUrl degrades to the feed base, and tolerates null feed/product', () => {
	assert.strictEqual(U.downloadUrl({ url: 'https://x/a.zip' }, {}, 'https://levelcode.ai'), 'https://levelcode.ai');
	assert.strictEqual(U.downloadUrl(null, null, 'https://levelcode.ai'), 'https://levelcode.ai');
	assert.strictEqual(U.downloadUrl(null, null, undefined), '');
});

console.log('\nupdate.js: ' + n + ' tests passed.');
