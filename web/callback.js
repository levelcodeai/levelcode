// The page the sign-in returns to. It hands the result to the editor tab through localStorage
// (the editor listens for the `storage` event) and then closes itself. Same contract as
// Code-OSS's callback.html; everything the page needs is in its own query string.
//
// It is a page of the editor's own site, so anyone can link to it, and whatever it writes the editor
// delivers when it next starts. So it carries back a LevelCode sign-in and nothing else: to the
// extension's sign-in address, and only the one-time code — which the editor exchanges with a secret
// only it holds. A link that brings anything else (a session token in the address, which the old flow
// used, or a result for another destination) is not passed on.
(function () {
	var SIGN_IN = { authority: 'levelcode.levelcode-ai', path: '/auth/callback' };
	/** sessionStorage: where the editor tab was when it left for the sign-in (web/main.js writes it). */
	var RETURN_KEY = 'levelcode-web.return';
	var title = document.getElementById('title');
	var text = document.getElementById('text');
	function say(t, s) { title.textContent = t; text.textContent = s; }
	function decode(v) { return v === null ? null : decodeURIComponent(v); }
	/** The editor address to come back to: the one this tab left, if it is the editor page of this site; else the editor's home. */
	function returnAddress(saved) {
		var home = new URL('./', location.href);
		if (!saved || saved === '1') { return home.href; }
		try {
			var t = new URL(saved, location.origin);
			var editorPage = t.pathname === home.pathname || t.pathname === home.pathname + 'index.html';
			if (t.origin !== location.origin || !editorPage) { return home.href; }
			t.searchParams.delete('signin');   // the account site's "Open in browser" asks for a sign-in; that is done
			return t.href;
		} catch (e) { return home.href; }
	}
	try {
		var params = new URL(location.href).searchParams;
		var id = decode(params.get('vscode-reqid'));
		var scheme = decode(params.get('vscode-scheme'));
		var authority = decode(params.get('vscode-authority'));
		var path = decode(params.get('vscode-path'));
		var query = decode(params.get('vscode-query'));
		var fragment = decode(params.get('vscode-fragment'));
		if (!id || !/^\d{1,9}$/.test(id) || !scheme || !authority
			|| authority.toLowerCase() !== SIGN_IN.authority || path !== SIGN_IN.path) {
			throw new Error('This page is only used to finish a sign-in from LevelCode.');
		}
		['vscode-reqid', 'vscode-scheme', 'vscode-authority', 'vscode-path', 'vscode-query', 'vscode-fragment'].forEach(function (k) { params.delete(k); });
		if (query) { new URLSearchParams(query).forEach(function (value, key) { params.set(key, value); }); }
		var code = params.get('code');
		// Take the address out of the address bar and history: a code is single-use, but it is a secret until it is used.
		history.replaceState(null, '', location.pathname);
		if (!code || code.length > 2048 || /\s/.test(code)) {
			if (params.get('error')) { say('The sign-in did not finish', 'Go back to LevelCode and try again.'); return; }
			throw new Error('This page is only used to finish a sign-in from LevelCode.');
		}
		var uri = { scheme: scheme, authority: SIGN_IN.authority, path: SIGN_IN.path, query: 'code=' + encodeURIComponent(code) };
		if (fragment) { uri.fragment = fragment; }
		// `at` lets the editor tell this result from one left behind long ago; the URL it is revived from ignores it.
		uri.at = Date.now();
		localStorage.setItem('vscode-web.url-callbacks[' + id + ']', JSON.stringify(uri));
		var saved = null;
		// Set by the editor when it took THIS tab to the sign-in (web/main.js); the editor clears it at start-up.
		try { saved = sessionStorage.getItem(RETURN_KEY); } catch (e) { /* no storage: the pop-up path */ }
		if (saved) {
			// This tab left the editor for the sign-in: go back to the same place — the same folder or workspace.
			// The editor finds the result at start-up.
			say('You are signed in', 'Back to LevelCode.');
			location.replace(returnAddress(saved));
		} else {
			var home = new URL('./', location.href).href;
			say('You are signed in', 'You can close this tab and go back to LevelCode.');
			var more = document.getElementById('more');
			if (more) { more.hidden = false; more.querySelector('a').href = home; }
			setTimeout(function () { try { window.close(); } catch (e) { /* the text above still tells the user */ } }, 600);
		}
	} catch (e) {
		say('This link does not look right', String((e && e.message) || e));
	}
})();
