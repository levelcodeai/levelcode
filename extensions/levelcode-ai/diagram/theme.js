/*---------------------------------------------------------------------------------------------
 *  LevelCode — AI · rich diagrams · the house style  (docs/RICH-DIAGRAMS.md, "Style guide")
 *
 *  ONE module owns every visual decision a diagram makes: the type scale, the box geometry, the
 *  spacing the layout reserves, and the colours. The layout reads the numbers, the painter reads the
 *  class names, the webview injects css(), and an exported file embeds css(resolved) — so the rule
 *  "the same style whichever model drew it" has exactly one place it can drift.
 *
 *  Colours are EDITOR THEME TOKENS, never literals: a diagram is drawn with `var(--lcd-*)`, and those
 *  are defined from `--vscode-*`. Switching the editor theme therefore restyles every diagram already
 *  on screen without re-rendering anything — nothing is baked in until the moment a file is exported.
 *
 *  Loads in Node (require) and in the chat webview (inlined by diagram/bundle.js) — no dependencies.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
(function (root, factory) {
	'use strict';
	if (typeof module === 'object' && module.exports) { module.exports = factory(); }
	else { (root.LCDiagram = root.LCDiagram || {}).theme = factory(); }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
	'use strict';

	/**
	 * The type scale. Three sizes carry a diagram (title 15, node name 13 semibold, secondary 11.5);
	 * edge and group labels are "secondary lines". `line` is the line box the layout reserves.
	 */
	const TYPE = {
		title: { size: 15, weight: 600, line: 20 },
		name: { size: 13, weight: 600, line: 18 },
		sub: { size: 11.5, weight: 400, line: 16 },
		edge: { size: 11.5, weight: 400, line: 16 },
		group: { size: 11.5, weight: 600, line: 16 }
	};
	/** Nothing in a diagram is set smaller than this — the floor the style guide names. */
	const MIN_TEXT = 10.5;

	/** Box geometry: corner radius 8, border 1.25 (2 on the accent), padding 12. */
	const BOX = {
		radius: 8, border: 1.25, accentBorder: 2,
		padX: 12, padY: 12,
		textGap: 2,          // between the name line and the secondary line
		minWidth: 64,        // a one-letter label is still a box, not a pill of padding
		linkIcon: 14         // extra width a linked node reserves for its file glyph
	};

	/**
	 * Everything the layout reserves between things. Kept here, not in layout.js, because these ARE
	 * style decisions — "connectors routed through gaps" is only true if the gaps exist.
	 */
	const SPACE = {
		margin: 8,           // around the whole drawing, so a 2px accent border is never clipped
		nodeGap: 22,         // between neighbours in the same rank (across the flow)
		rankGap: 44,         // minimum between ranks (along the flow) before channels/labels widen it
		track: 12,           // between parallel connector segments in a channel
		channelPad: 16,      // from a node's side to the first channel track
		portGap: 12,         // between connectors leaving the same side of a node
		portInset: 8,        // keep ports off the rounded corners
		lineClear: 12,       // a connector passing a node keeps this far from its border
		groupInset: 16,      // children sit this far inside their group
		groupHeader: 20,     // the strip a group's label occupies above its children
		groupGap: 14,        // between a group's border and anything outside it
		labelGap: 5,         // "labels beside lines with a clear gap"
		labelPad: 6,         // breathing room around an edge label when checking for collisions
		arrow: 7,            // arrowhead length
		arrowHalf: 3.6,      // arrowhead half-width
		selfLoop: 16         // how far a self-loop steps out of its node
	};

	/**
	 * The live token map: `--lcd-*` custom properties, each defined from editor theme variables.
	 * Neutral boxes and ONE accent — the accent is the theme's link colour because that is the one
	 * hue every theme guarantees is legible on the editor background.
	 */
	const TOKENS = {
		fg: 'var(--vscode-foreground)',
		bg: 'var(--vscode-editor-background)',
		muted: 'var(--vscode-descriptionForeground, color-mix(in srgb, var(--vscode-foreground) 68%, transparent))',
		line: 'color-mix(in srgb, var(--vscode-foreground) 56%, transparent)',
		'node-fill': 'color-mix(in srgb, var(--vscode-foreground) 5%, transparent)',
		'node-stroke': 'color-mix(in srgb, var(--vscode-foreground) 36%, transparent)',
		accent: 'var(--vscode-textLink-foreground, var(--vscode-focusBorder, #4c8dff))',
		'accent-fill': 'color-mix(in srgb, var(--vscode-textLink-foreground, var(--vscode-focusBorder, #4c8dff)) 14%, transparent)',
		'group-fill': 'color-mix(in srgb, var(--vscode-foreground) 3.5%, transparent)',
		'group-stroke': 'color-mix(in srgb, var(--vscode-foreground) 17%, transparent)',
		font: 'var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)'
	};
	const TOKEN_NAMES = Object.keys(TOKENS);

	/**
	 * Concrete palettes — used ONLY where there is no editor to ask: the Node-side snapshot tests, the
	 * docs, and as the fallback when an export cannot read computed styles. The live view never
	 * touches these.
	 */
	const PALETTES = {
		light: {
			fg: '#1f2328', bg: '#ffffff', muted: '#59636e', line: '#7d8590',
			'node-fill': '#f4f5f6', 'node-stroke': '#aeb4bb',
			accent: '#0969da', 'accent-fill': '#ddebfb',
			'group-fill': '#f8f9fa', 'group-stroke': '#d5d9de',
			font: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif'
		},
		dark: {
			fg: '#d4d7dc', bg: '#1e1f22', muted: '#9198a1', line: '#8b929b',
			'node-fill': '#27292d', 'node-stroke': '#5f666f',
			accent: '#4c9aff', 'accent-fill': '#1f3350',
			'group-fill': '#232528', 'group-stroke': '#3a3e44',
			font: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif'
		}
	};

	/**
	 * The stylesheet, generated from the tables above.
	 *
	 *   css()                     live: rules read `var(--lcd-*)`, and `.lcd` defines them from the theme.
	 *   css({ resolved: {...} })  export: every token replaced by a concrete value, scoped to `svg.lcd-svg`
	 *                             so the block can sit inside a standalone SVG file.
	 *
	 * Selectors are all class-based and prefixed `lcd-`, so nothing here can reach the rest of the chat.
	 * @param {{ resolved?: Record<string,string> }} [opts]
	 */
	function css(opts) {
		const resolved = opts && opts.resolved;
		const v = (name) => (resolved ? String(resolved[name] != null ? resolved[name] : PALETTES.light[name]) : 'var(--lcd-' + name + ')');
		const scope = resolved ? 'svg.lcd-svg' : '.lcd';
		const t = TYPE;
		const out = [];
		if (!resolved) {
			out.push(scope + ' {' + TOKEN_NAMES.map((n) => ' --lcd-' + n + ': ' + TOKENS[n] + ';').join('') + ' }');
			// High-contrast themes ask for real borders, not tints.
			out.push('body.vscode-high-contrast ' + scope + ', body.vscode-high-contrast-light ' + scope
				+ ' { --lcd-node-stroke: var(--vscode-contrastBorder, var(--vscode-foreground));'
				+ ' --lcd-group-stroke: var(--vscode-contrastBorder, var(--vscode-foreground));'
				+ ' --lcd-line: var(--vscode-foreground); --lcd-node-fill: transparent; --lcd-group-fill: transparent; }');
		}
		const text = (cls, type, fill) => scope + ' .' + cls + ' { font-family: ' + v('font') + '; font-size: ' + type.size + 'px; font-weight: '
			+ type.weight + '; fill: ' + v(fill) + '; }';
		out.push(
			scope + ' .lcd-bg { fill: ' + v('bg') + '; }',
			scope + ' text { font-family: ' + v('font') + '; }',
			text('lcd-title', t.title, 'fg'),
			text('lcd-name', t.name, 'fg'),
			text('lcd-sub', t.sub, 'muted'),
			text('lcd-edge-label', t.edge, 'muted'),
			text('lcd-group-label', t.group, 'muted'),
			scope + ' .lcd-shape { fill: ' + v('node-fill') + '; stroke: ' + v('node-stroke') + '; stroke-width: ' + BOX.border + 'px; stroke-linejoin: round; }',
			scope + ' .lcd-accent .lcd-shape { fill: ' + v('accent-fill') + '; stroke: ' + v('accent') + '; stroke-width: ' + BOX.accentBorder + 'px; }',
			scope + ' .lcd-node .lcd-lid { fill: none; }',
			scope + ' .lcd-group-box { fill: ' + v('group-fill') + '; stroke: ' + v('group-stroke') + '; stroke-width: 1px; }',
			scope + ' .lcd-edge { fill: none; stroke: ' + v('line') + '; stroke-width: 1.25px; stroke-linejoin: round; stroke-linecap: round; }',
			scope + ' .lcd-edge.lcd-dashed { stroke-dasharray: 5 4; }',
			scope + ' .lcd-arrow { fill: ' + v('line') + '; stroke: ' + v('line') + '; stroke-width: 1px; stroke-linejoin: round; }',
			scope + ' .lcd-link-icon { fill: none; stroke: ' + v('muted') + '; stroke-width: 1px; stroke-linejoin: round; }',
			// The halo is the LAST resort of label placement (a label that had nowhere clear to sit):
			// it keeps the text legible over a line it could not avoid.
			scope + ' .lcd-halo { paint-order: stroke; stroke: ' + v('bg') + '; stroke-width: 4px; stroke-linejoin: round; }'
		);
		if (!resolved) {
			out.push(
				scope + ' .lcd-linked { cursor: pointer; }',
				scope + ' .lcd-linked:hover .lcd-shape, ' + scope + ' .lcd-linked:focus-visible .lcd-shape { stroke: ' + v('accent') + '; }',
				scope + ' .lcd-linked:hover .lcd-link-icon, ' + scope + ' .lcd-linked:focus-visible .lcd-link-icon { stroke: ' + v('accent') + '; }',
				scope + ' .lcd-linked:focus { outline: none; }'
			);
		}
		return out.join('\n');
	}

	// ---- text measurement without a browser ----------------------------------------------------
	// The webview measures with a canvas and the real UI font. Node has neither, so tests, the ASCII
	// renderer and the host's size estimates use this table: per-character advance in em, calibrated
	// against a system UI sans. It errs slightly WIDE, because the failure that matters is text
	// overflowing its box, not a box two pixels too roomy.
	const NARROW = new Set(Array.from("iIl.,:;'|!jtfr()[]{}` "));
	const WIDE = new Set(Array.from('mwMW@%&'));
	function charEm(ch) {
		if (NARROW.has(ch)) { return 0.33; }
		if (WIDE.has(ch)) { return 0.88; }
		const c = ch.codePointAt(0) || 0;
		if (c >= 0x30 && c <= 0x39) { return 0.60; }          // digits
		if (c >= 0x41 && c <= 0x5a) { return 0.69; }          // A–Z
		if (c > 0xffff) { return 1.1; }                       // emoji and everything else beyond the basic plane — asked first: all of it is above U+2E80 too
		if (c >= 0x2e80) { return 1.0; }                      // CJK and other full-width scripts
		return 0.57;
	}
	/**
	 * Approximate rendered width, in px, of `text` set in the role's type.
	 * @param {string} text
	 * @param {keyof typeof TYPE} role
	 */
	function approxMeasure(text, role) {
		const ty = TYPE[role] || TYPE.sub;
		let em = 0;
		for (const ch of Array.from(String(text == null ? '' : text))) { em += charEm(ch); }
		return Math.ceil(em * ty.size * (ty.weight >= 600 ? 1.045 : 1) * 10) / 10;
	}

	return { TYPE, MIN_TEXT, BOX, SPACE, TOKENS, TOKEN_NAMES, PALETTES, css, approxMeasure };
}));
