/* LevelCode in your browser — the chat skin's script. Runs after chat.html's own script, in the same page, and
   uses only what that page already has: its DOM, its top-level `vscode` handle and the messages it already sends.
   Nothing here talks to the host in a way the page does not already. */
(function () {
	'use strict';
	if (!document.body || !document.body.classList.contains('lc-web')) { return; }

	// Each one must make sense in an empty window: no open file, no selection (the first layout has no editor).
	var STARTERS = [
		['Build a small web page', 'Create an index.html with a simple, good-looking landing page.'],
		['Explain this project', 'Look through the files here and explain what this project does.'],
		['Fix a bug', 'Look through the files here for bugs, fix the most likely one and tell me what you changed.'],
		['Write tests', 'Add tests for the main logic of this project, using the test setup that is already here or suggesting one.'],
	];
	var post = function (m) { try { vscode.postMessage(m); } catch (e) { /* the page is going away */ } };

	/* ----- the empty chat ------------------------------------------------------------------------ */
	function fill(q) {
		var i = document.getElementById('input');
		if (!i) { return; }
		i.value = q;
		i.dispatchEvent(new Event('input', { bubbles: true }));
		i.focus();
	}
	function el(tag, cls, text) {
		var n = document.createElement(tag);
		if (cls) { n.className = cls; }
		if (text) { n.textContent = text; }
		return n;
	}
	function hero() {
		var e = document.getElementById('empty');
		if (!e || e.getAttribute('data-lcw')) { return; }
		e.setAttribute('data-lcw', '1');
		e.textContent = '';
		var logo = document.getElementById('lcLogo');
		if (logo) {
			var m = logo.cloneNode(true);
			m.removeAttribute('id');
			m.setAttribute('class', 'lcw-mark');
			m.setAttribute('aria-hidden', 'true');
			e.appendChild(m);
		}
		e.appendChild(el('h1', 'lcw-hero', 'What do you want to build?'));
		e.appendChild(el('p', 'lcw-sub', 'Describe a goal. LevelCode reads your files, makes a plan and edits them, and you keep or undo each change.'));
		var row = el('div', 'starters');
		STARTERS.forEach(function (s) {
			var b = el('button', 'starter', s[0]);
			b.type = 'button';
			b.addEventListener('click', function () { fill(s[1]); });
			row.appendChild(b);
		});
		e.appendChild(row);
	}
	var log = document.getElementById('log');
	if (log && typeof MutationObserver === 'function') { new MutationObserver(hero).observe(log, { childList: true }); }
	hero();

	/* ----- the conversation list, docked on the left when there is room -------------------------- */
	var rail = window.matchMedia('(min-width: 1000px)');
	var timer = 0;
	function ask() {
		clearTimeout(timer);
		// The list is the page's own (sessions / sessionAction); asking is all it takes. Never openSessions():
		// it seeds the list with sample cards when nothing has arrived yet.
		timer = setTimeout(function () { post({ type: 'listSessions' }); }, 150);
	}
	window.addEventListener('message', function (e) {
		var t = e && e.data && e.data.type;
		if (t === 'agentDone' || t === 'assistantDone' || t === 'reset' || t === 'sessionResumed' || t === 'sessionUndo') { ask(); }
	});
	var panel = document.querySelector('#sessOverlay .sesspanel');
	var bar = document.querySelector('#sessOverlay .sessbar');
	if (bar && !bar.querySelector('.lcw-new')) {
		var nb = el('button', 'lcw-new', '+ New chat');
		nb.type = 'button';
		nb.title = 'Start a new chat';
		nb.addEventListener('click', function () { post({ type: 'newChat' }); });
		bar.appendChild(nb);
	}
	var overlay = document.getElementById('sessOverlay');
	function sync() {
		if (panel) {
			panel.setAttribute('role', rail.matches ? 'complementary' : 'dialog');
			// aria-modal is only meaningful on a dialog; on the docked list it is left off, not set to false.
			if (rail.matches) { panel.removeAttribute('aria-modal'); } else { panel.setAttribute('aria-modal', 'true'); }
		}
		// /sessions opened while the list was docked leaves the overlay's inline display on; narrowing the window
		// would then show it as a modal nobody asked for. Below the breakpoint it is closed until it is asked for.
		if (overlay && !rail.matches) { overlay.style.display = 'none'; }
		if (rail.matches) { ask(); }
	}
	// A card is a div with a role of button and a click handler only: Enter and Space do nothing on it. Do what a
	// button does, for the card itself (its own buttons are real buttons and already work).
	var list = document.getElementById('sessList');
	if (list) {
		list.addEventListener('keydown', function (e) {
			var t = e.target;
			if ((e.key === 'Enter' || e.key === ' ') && t && t.classList && t.classList.contains('sesscard')) {
				e.preventDefault();
				t.click();
			}
		});
	}
	if (rail.addEventListener) { rail.addEventListener('change', sync); }
	sync();
})();
