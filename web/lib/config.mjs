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
		staticBase: o.staticBase || '/static',
		callbackRoute: '/callback.html',
		extensions: o.extensions || ['levelcode-ai'],
		scratch: { scheme: 'levelcode-scratch', path: '/' },
		trustedDomains: [account],
		productConfiguration: Object.assign({}, o.productConfiguration),
		configurationDefaults: Object.assign({
			'levelcode.cloud.endpoint': account,
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
		.replaceAll('{{STATIC}}', config.staticBase)
		.replace('{{CONFIG}}', () => json);
}

function trimSlash(s) { return String(s).replace(/\/+$/, ''); }
