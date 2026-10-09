// The page the sign-in returns to. It hands the result to the editor tab through localStorage
// (the editor listens for the `storage` event) and then closes itself. Same contract as
// Code-OSS's callback.html; everything the page needs is in its own query string.
(function () {
	var title = document.getElementById('title');
	var text = document.getElementById('text');
	function say(t, s) { title.textContent = t; text.textContent = s; }
	function decode(v) { return v === null ? null : decodeURIComponent(v); }
	try {
		var params = new URL(location.href).searchParams;
		var id = decode(params.get('vscode-reqid'));
		var scheme = decode(params.get('vscode-scheme'));
		var authority = decode(params.get('vscode-authority'));
		if (!id || !scheme || !authority) { throw new Error('This page is only used to finish a sign-in from LevelCode.'); }
		var uri = { scheme: scheme, authority: authority };
		var path = decode(params.get('vscode-path'));
		var query = decode(params.get('vscode-query'));
		var fragment = decode(params.get('vscode-fragment'));
		['vscode-reqid', 'vscode-scheme', 'vscode-authority', 'vscode-path', 'vscode-query', 'vscode-fragment'].forEach(function (k) { params.delete(k); });
		if (path) { uri.path = path; }
		if (query) { new URLSearchParams(query).forEach(function (value, key) { params.set(key, value); }); }
		var rest = params.toString();
		if (rest) { uri.query = rest; }
		if (fragment) { uri.fragment = fragment; }
		// `at` lets the editor tell this result from one left behind long ago; the URL it is revived from ignores it.
		uri.at = Date.now();
		localStorage.setItem('vscode-web.url-callbacks[' + id + ']', JSON.stringify(uri));
		// Take the one-time code out of the address bar and history.
		history.replaceState(null, '', location.pathname);
		var home = new URL('./', location.href).href;
		var back = false;
		// Set by the editor when it took THIS tab to the sign-in (web/main.js); the editor clears it at start-up.
		try { back = sessionStorage.getItem('levelcode-web.return') === '1'; } catch (e) { /* no storage: the pop-up path */ }
		if (back) {
			// This tab left the editor for the sign-in: go back. The editor finds the result at start-up.
			say('You are signed in', 'Back to LevelCode.');
			location.replace(home);
		} else {
			say('You are signed in', 'You can close this tab and go back to LevelCode.');
			var more = document.getElementById('more');
			if (more) { more.hidden = false; more.querySelector('a').href = home; }
			setTimeout(function () { try { window.close(); } catch (e) { /* the text above still tells the user */ } }, 600);
		}
	} catch (e) {
		say('This link does not look right', String((e && e.message) || e));
	}
})();
