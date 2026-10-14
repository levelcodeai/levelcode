// `turndown` is the HTML -> Markdown converter behind just-bash's `html-to-markdown`. Its browser build needs `document`,
// which a worker does not have, so the command never worked here; the engine registers it anyway. The shell answers
// "command not found" for it (compat.js), and this stub keeps the 40 KB converter out of the bundle.
export default class TurndownService {
	constructor() {
		throw new Error('html-to-markdown is not available in the browser');
	}
}
