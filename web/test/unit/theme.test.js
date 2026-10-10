/*---------------------------------------------------------------------------------------------
 *  The browser edition's colour themes and look configuration — run: node web/test/unit/theme.test.js
 *
 *  A theme is data, so what can go wrong is quiet: a colour that is missing and falls back to a default that
 *  does not belong, text that cannot be read, a default that names a theme the page does not have, or a pinned
 *  default somewhere else that outranks ours. These tests read the files the build ships.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..', '..', '..');
const THEME_DIR = path.join(REPO, 'web', 'theme', 'levelcode-web-theme');
const pkg = JSON.parse(fs.readFileSync(path.join(THEME_DIR, 'package.json'), 'utf8'));
const themes = Object.fromEntries(pkg.contributes.themes.map((t) => [t.label, { ...t, json: JSON.parse(fs.readFileSync(path.join(THEME_DIR, t.path), 'utf8')) }]));

let n = 0;
async function test(name, fn) { await fn(); n++; console.log('  ok - ' + name); }

/** WCAG relative luminance and contrast of two #rrggbb colours (an alpha channel, if any, is ignored). */
function lum(hex) {
	const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
	return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function contrast(a, b) { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }
/** Composite a #rrggbbaa over a #rrggbb ground. */
function over(top, ground) {
	if (top.length === 7) { return top; }
	const a = parseInt(top.slice(7, 9), 16) / 255;
	const mix = (i) => Math.round(parseInt(top.slice(i, i + 2), 16) * a + parseInt(ground.slice(i, i + 2), 16) * (1 - a));
	return '#' + [1, 3, 5].map((i) => mix(i).toString(16).padStart(2, '0')).join('');
}

(async () => {
	const { webConfig } = await import(pathToFileURL(path.join(REPO, 'web', 'lib', 'config.mjs')).href);
	const { withoutConfigurationDefaults } = await import(pathToFileURL(path.join(REPO, 'web', 'lib', 'extensions.mjs')).href);

	await test('the package names two themes, one dark and one light, and their files exist', () => {
		assert.deepStrictEqual(Object.keys(themes).sort(), ['LevelCode Web Dark', 'LevelCode Web Light']);
		assert.strictEqual(themes['LevelCode Web Dark'].uiTheme, 'vs-dark');
		assert.strictEqual(themes['LevelCode Web Light'].uiTheme, 'vs');
		assert.strictEqual(themes['LevelCode Web Dark'].json.type, 'dark');
		assert.strictEqual(themes['LevelCode Web Light'].json.type, 'light');
		assert.ok(!pkg.contributes.configurationDefaults, 'a default theme pinned here would race the page\'s own');
	});

	await test('every colour is a hex value, and the surfaces the look is made of are all there', () => {
		const MUST = ['foreground', 'focusBorder', 'editor.background', 'editor.foreground', 'sideBar.background', 'sideBar.border', 'activityBar.background', 'activityBar.foreground',
			'titleBar.activeBackground', 'statusBar.background', 'panel.background', 'panel.border', 'tab.activeBackground', 'tab.inactiveBackground', 'editorGroupHeader.tabsBackground',
			'input.background', 'input.border', 'button.background', 'button.foreground', 'list.hoverBackground', 'list.activeSelectionBackground', 'menu.background', 'quickInput.background',
			'terminal.background', 'terminal.foreground', 'terminal.ansiRed', 'terminal.ansiBrightWhite', 'agentsPanel.background', 'agentsPanel.border', 'editorWidget.background', 'scrollbarSlider.background'];
		for (const t of Object.values(themes)) {
			for (const [k, v] of Object.entries(t.json.colors)) { assert.ok(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v), `${t.label}: ${k} = ${v}`); }
			assert.deepStrictEqual(MUST.filter((k) => !t.json.colors[k]), [], t.label);
			assert.ok(t.json.tokenColors.length > 20, 'syntax colours');
		}
	});

	await test('text can be read: foreground, secondary text and the button label meet WCAG contrast on their grounds', () => {
		for (const t of Object.values(themes)) {
			const c = t.json.colors;
			const editor = c['editor.background'];
			const chrome = c['sideBar.background'];
			assert.ok(contrast(c.foreground, editor) >= 7, `${t.label}: foreground on the editor ${contrast(c.foreground, editor).toFixed(2)}`);
			assert.ok(contrast(c['sideBar.foreground'], chrome) >= 4.5, `${t.label}: side bar text ${contrast(c['sideBar.foreground'], chrome).toFixed(2)}`);
			assert.ok(contrast(c['tab.inactiveForeground'], c['tab.inactiveBackground']) >= 4.5, `${t.label}: inactive tab`);
			assert.ok(contrast(c['button.foreground'], c['button.background']) >= 4.5, `${t.label}: button label ${contrast(c['button.foreground'], c['button.background']).toFixed(2)}`);
			assert.ok(contrast(c['input.placeholderForeground'], over(c['input.background'], editor)) >= 3, `${t.label}: placeholder`);
			assert.ok(contrast(c['statusBar.foreground'], c['statusBar.background']) >= 4.5, `${t.label}: status bar`);
		}
	});

	await test('the editor is one step apart from the chrome, in the right direction for each theme', () => {
		const d = themes['LevelCode Web Dark'].json.colors;
		const l = themes['LevelCode Web Light'].json.colors;
		assert.ok(lum(d['editor.background']) > lum(d['sideBar.background']), 'dark: the editor is lighter than the chrome');
		assert.ok(lum(l['editor.background']) > lum(l['sideBar.background']), 'light: the editor is lighter than the chrome');
		for (const c of [d, l]) {
			for (const k of ['activityBar.background', 'titleBar.activeBackground', 'statusBar.background', 'tab.inactiveBackground', 'editorGroupHeader.tabsBackground']) {
				assert.strictEqual(c[k], c['sideBar.background'], `${k} is the same chrome as the side bar`);
			}
			assert.strictEqual(c['tab.activeBackground'], c['editor.background']);
		}
	});

	await test('the page\'s configuration names themes that exist, and only the page decides the default', () => {
		const cfg = webConfig({ account: 'https://levelcode.example' }).configurationDefaults;
		for (const k of ['workbench.colorTheme', 'workbench.preferredDarkColorTheme', 'workbench.preferredLightColorTheme']) {
			assert.ok(themes[cfg[k]], `${k} = ${cfg[k]} is not a theme the page ships`);
		}
		assert.strictEqual(cfg['workbench.preferredDarkColorTheme'], 'LevelCode Web Dark');
		assert.strictEqual(cfg['workbench.preferredLightColorTheme'], 'LevelCode Web Light');
		assert.strictEqual(cfg['window.autoDetectColorScheme'], true);
		// the chat's group is kept apart under the same view type the layout code looks for
		const ws = fs.readFileSync(path.join(REPO, 'web', 'workspace', 'extension.js'), 'utf8');
		const viewType = (ws.match(/const CHAT_VIEW_TYPE = '([^']+)'/) || [])[1];
		assert.ok(viewType && Object.keys(cfg['workbench.editor.autoLockGroups']).includes(viewType), `autoLockGroups does not name ${viewType}`);
	});

	await test('the colours painted before the theme loads are the theme\'s own', () => {
		const init = webConfig({ account: 'https://levelcode.example' }).initialColorTheme;
		const d = themes['LevelCode Web Dark'].json.colors;
		const l = themes['LevelCode Web Light'].json.colors;
		for (const [which, c] of [['dark', d], ['light', l]]) {
			assert.strictEqual(init[which].colors['editor.background'], c['editor.background']);
			assert.strictEqual(init[which].colors['sideBar.background'], c['sideBar.background']);
			assert.strictEqual(init[which].colors.foreground, c.foreground);
		}
		assert.strictEqual(init.dark.themeType, 'dark');
		assert.strictEqual(init.light.themeType, 'light');
	});

	await test('the desktop themes\' pinned default is removed from the staged copy, and only that', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-theme-'));
		try {
			const file = path.join(dir, 'package.json');
			const source = fs.readFileSync(path.join(REPO, 'extensions', 'levelcode-themes', 'package.json'), 'utf8');
			assert.ok(/configurationDefaults/.test(source), 'the desktop extension still pins its default');
			fs.writeFileSync(file, source);
			assert.strictEqual(withoutConfigurationDefaults(file), true);
			const staged = JSON.parse(fs.readFileSync(file, 'utf8'));
			const original = JSON.parse(source);
			assert.ok(!('configurationDefaults' in staged.contributes));
			assert.deepStrictEqual(staged.contributes.themes, original.contributes.themes, 'both of its themes stay selectable');
			assert.strictEqual(withoutConfigurationDefaults(file), false, 'nothing left to remove');
			assert.ok(/configurationDefaults/.test(fs.readFileSync(path.join(REPO, 'extensions', 'levelcode-themes', 'package.json'), 'utf8')), 'the desktop source is not touched');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });   // a failed assertion must not leave it behind either
		}
	});

	console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
