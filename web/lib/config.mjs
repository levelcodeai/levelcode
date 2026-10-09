// The page configuration, in one place. `serve.mjs` (development) and `scripts/build-web.mjs`
// (release) both call webConfig() and renderIndex(), so what you test locally is what ships.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEB_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * @param {object} o
 * @param {string} [o.account]      LevelCode Cloud origin the editor signs in to and calls (the gateway lives there).
 * @param {string[]} [o.extensions] Folder names, under /extensions, of the extensions loaded as built-ins.
 * @param {string} [o.staticBase]   Where the Code-OSS web build is mounted.
 * @param {object} [o.productConfiguration] Overrides merged over the product the build embeds.
 * @param {object} [o.configurationDefaults]
 * @param {boolean} [o.development]
 */
export function webConfig(o = {}) {
	const account = trimSlash(o.account || 'https://levelcode.ai');
	return {
		// Where the page's own scripts and styles, the Code-OSS web build, and the extensions are mounted.
		// A release puts all three under one build-addressed prefix (/_/<id>) so they can be cached for
		// a year; the development server mounts them at the root, /static and /extensions.
		account,
		base: o.base || '',
		staticBase: o.staticBase || '/static',
		extensionsBase: o.extensionsBase || '/extensions',
		callbackRoute: '/callback.html',
		extensions: o.extensions || ['levelcode-ai'],
		// The folder is /scratch, not the provider's root: a root named "/" is what the title bar and the
		// Explorer would show, and "scratch" is what it is.
		scratch: { scheme: 'levelcode-scratch', path: '/scratch' },
		trustedDomains: [account],
		productConfiguration: Object.assign({
			// The scratch workspace implements file and text search for its own scheme. Spelling the grant
			// out here (rather than relying on "built-in extensions may declare proposals") is the
			// sanctioned route and keeps the workbench from logging an error about it at start.
			extensionEnabledApiProposals: { 'levelcode.levelcode-web': ['fileSearchProvider', 'textSearchProvider'] },
		}, o.productConfiguration),
		configurationDefaults: Object.assign({
			'levelcode.cloud.endpoint': account,
			// LevelCode is the assistant here; the stock Copilot surfaces (status item, chat view, command
			// center) are for an account this editor does not use. The desktop app sets the same.
			'chat.disableAIFeatures': true,
			'chat.commandCenter.enabled': false,
			'workbench.startupEditor': 'none',
			'telemetry.telemetryLevel': 'off',
			'update.mode': 'none',
			'extensions.autoUpdate': false,
			'extensions.autoCheckUpdates': false,
			'security.workspace.trust.enabled': false,
		}, o.configurationDefaults),
		development: !!o.development,
	};
}

export function renderIndex(config, htmlPath = path.join(WEB_DIR, 'index.html')) {
	const json = JSON.stringify(config).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
	return fs.readFileSync(htmlPath, 'utf8')
		.replaceAll('{{BASE}}', config.base)
		.replaceAll('{{STATIC}}', config.staticBase)
		.replace('{{CONFIG}}', () => json);
}

function trimSlash(s) { return String(s).replace(/\/+$/, ''); }
