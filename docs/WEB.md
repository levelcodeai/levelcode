# LevelCode in your browser

The same workbench, the same `levelcode-ai` extension, in a browser tab: sign in with a LevelCode
account and chat with the agent against the gateway, or bring a provider key. There is nothing to
install and no server of ours that runs code — the editor is a **static directory**.

This page is the engineering reference: how it fits together, how to build and serve it, what the
host has to provide, the security model, and — kept separate on purpose — what has and has not been
run. For the product's own page and copy see the account site (`/web`, `/docs/browser`).

- [What it is, and what it is not](#what-it-is-and-what-it-is-not)
- [How it fits together](#how-it-fits-together)
- [Signing in](#signing-in)
- [Build and run](#build-and-run)
- [Deploying](#deploying) — origins, headers, backend settings
- [Security model](#security-model)
- [Where state lives](#where-state-lives)
- [Keeping the desktop and the browser in step](#keeping-the-desktop-and-the-browser-in-step)
- [Tests](#tests) — and [what was not run](#what-was-not-run)
- [Decisions that are the owner's](#decisions-that-are-the-owners)

## What it is, and what it is not

A Code-OSS **web client** (the `vscode-web-min-ci` build of the pinned checkout) with a
**web-worker extension host**, plus LevelCode's own extensions loaded as built-ins.

| Works in a tab | Stays in the Mac app |
| --- | --- |
| The workbench: explorer, editor tabs, themes, search, Quick Open | A terminal |
| Chat, inline completion, the agent: read / search / create / edit / delete files | `run_command`, background commands, auto-verify commands |
| Keep / Undo review of the agent's edits | MCP servers that start local processes |
| Sign in with a LevelCode account (gateway), **or** your own provider key | Installing extensions (no marketplace in the page) |
| A scratch workspace saved in the browser (every modern browser) | Importing another editor's settings, Settings Sync, the update check |
| A folder from your computer (File System Access API: Chrome, Edge) | The Notepad++ pack and the customization pack (not loaded in the page), Agent Sketch |

The browser build offers the agent **only the tools it can honour**: with no shell the shell tools
are withheld from the model rather than offered and failing, and the system prompt is derived from
the same lines so it never promises one (`host.caps`, see below).

## How it fits together

```
 account site (levelcode.ai)                      editor origin (any static host)
 ┌───────────────────────────┐   tab goes to    ┌──────────────────────────────────────────────┐
 │ /ai/login   (sign-in)     │◀─────────────────│ index.html  ← build-addressed /_/<id>/…      │
 │ /api/levelcode/v1/…       │──── ?code= ─────▶│ main.js        embedder: config, callbacks,  │
 │   auth/exchange          │   /callback.html  │                secrets, workspace, commands   │
 │   account/models         │                   │ callback.html  hands the result back (storage)│
 │   ai/chat/completions     │◀──── fetch ──────│ ┌─ workbench (Code-OSS web client) ────────┐ │
 └───────────────────────────┘    (CORS)        │ │  web-worker extension host (iframe)      │ │
                                                │ │   levelcode-ai   esbuild bundle + shims  │ │
   provider you chose  ◀──── fetch (BYOK) ──────│ │   levelcode-web  scratch workspace       │ │
                                                │ │  chat webview  (own origin, see below)   │ │
                                                │ └──────────────────────────────────────────┘ │
                                                └──────────────────────────────────────────────┘
```

| Path | What it is |
| --- | --- |
| `scripts/build-web.mjs` | One command → `dist-web/`: the client, the extensions, `index.html` with the configuration baked in, `_headers`, an nginx fragment, `build.json`. Changes nothing outside `--out`. |
| `web/main.js`, `index.html`, `boot.css` | The page. Plain ES module, no build step: reads `#levelcode-web-config`, creates the workbench, supplies the URL-callback provider, the secret store, the workspace provider and the `levelcode.web.openAuthUrl` command. |
| `web/callback.html`, `callback.js` | The page a sign-in returns to. |
| `web/lib/config.mjs`, `headers.mjs`, `extensions.mjs` | The configuration, the HTTP policy and the extension staging — shared by the dev server and the release, so what is tested is what ships. |
| `web/ai-extension/` | The browser build of `levelcode-ai`: `build.mjs` (esbuild, `platform: browser`), `shims/` (`fs`, `path`, `os`, `crypto`, `child_process`, `process`), `manifest.js` (the desktop manifest minus what a tab cannot do), `copy.js` (the few strings that are true on a Mac and false in a tab). |
| `extensions/levelcode-ai/host.js` | The one place the desktop/browser difference lives in the extension (see below). |
| `web/workspace/` | The `levelcode-web` extension: the **scratch workspace** (`levelcode-scratch:` file system in IndexedDB, with file and text search), and the commands to open a local folder or the scratch. |
| `web/serve.mjs` | Dev / end-to-end server. Serves a build (`--dist`) with its own `_headers`, or the pieces (`--static`, `--extensions`). |
| `web/test/` | Unit tests (`unit/`) and the end-to-end checks (`e2e*.mjs`) with a hand-written CDP driver and a stand-in backend. |

### The extension runs unchanged — through `host.js`

`extensions/levelcode-ai` is the **same source** on both. Its Node-only assumptions are handled in
two places only:

1. **`web/ai-extension/shims/`** — the build swaps `fs`, `path`, `os`, `crypto`, `child_process`
   for small in-memory/IndexedDB stand-ins for the extension's *private* state (sessions, memory,
   images). `path` and `crypto` are compared against Node's over many inputs.
2. **`extensions/levelcode-ai/host.js`** — the user's *workspace* is not in the shim and must never
   be: in a tab it is whatever the editor's file-system provider says, and every read is
   asynchronous. `host` gives `readText`, `readBytes`, `stat`, `exists`, `isBinary`, `findFiles`,
   `withReads`, `openAuth` and the capability flags `caps.shell`, `caps.mcpStdio`, `caps.ripgrep`.
   On the desktop each function does exactly what the call site did before, behind `await`.

The two rules that keep the desktop app exactly as it was:

- **On the desktop every `host` function does what the call site did before** — the same `fs`
  call, the same error.
- **Nothing outside `host.js` asks "am I in a browser?".** A call site asks for a capability
  (`host.caps.shell`) or calls a function that already knows.

## Signing in

The extension's existing PKCE flow, with the browser's pieces in place of the OS's:

```
1  extension   accountSignIn(): verifier → SecretStorage; builds
               <account>/ai/login?redirect_uri=<callback>&code_challenge=<S256>
2  extension   host.openAuth(uri) → command levelcode.web.openAuthUrl (registered by main.js)
3  main.js     checks the address is <account>/ai/…, marks the tab (sessionStorage), location.assign
4  account     already signed in there → mints a one-time code bound to the challenge, 302 to
               <editor>/callback.html?vscode-reqid=N&vscode-scheme=levelcode
                 &vscode-authority=levelcode.levelcode-ai&vscode-path=%2Fauth%2Fcallback&code=…
               (not signed in → the login page first)
5  callback    writes localStorage "vscode-web.url-callbacks[N]" (dated), sees the mark → goes back to /
6  main.js     at start-up, once the workbench is listening, delivers a fresh result as
               levelcode://levelcode.levelcode-ai/auth/callback?code=… to the URL service
7  extension   handleAuthCallback → POST /api/levelcode/v1/auth/exchange {code, verifier} → tokens
```

Why the tab leaves instead of opening a pop-up: a window opened from a chain that began in a
webview is the first thing a strict browser (Safari, a phone) refuses. Leaving the tab and
returning needs no permission. The PKCE verifier lives in SecretStorage, so it survives the
navigation.

- **`?signin=1`** (the account site's "Open LevelCode" link) makes step 1 happen by itself, once:
  `main.js` removes the parameter, then delivers `levelcode://…/launch`, which focuses the chat and
  starts the sign-in only when there is no session.
- **A result is delivered only if it is fresh** (written in the last two minutes — the one-time
  code lives for a minute) and is removed either way. One left by a callback page whose editor
  tab is gone is delivered when the editor next starts.
- **`levelcode.web.openAuthUrl` is an open-redirect if it is loose**, and any extension in the page
  can call it. It goes only to `<account origin>/ai/…`.
- The address handed over is `encodeURI(uri.toString(true))` — the string the editor's own opener
  produces — so the server sees the same address however the sign-in was started. The backend
  decodes `redirect_uri` until stable (three rounds at most) and then applies the exact rule in
  `Levelcode::EditorCallback`.

## Build and run

Needs the bootstrapped Code-OSS checkout (`scripts/bootstrap.sh`, Node 24.x as the pin requires).

```bash
# the release: one static directory (about a minute for the client, then bundling)
node scripts/build-web.mjs --account https://levelcode.ai --out dist-web

# …serve it exactly as a static host would, with its own _headers
node web/serve.mjs --dist dist-web            # http://127.0.0.1:8800
```

| `build-web.mjs` flag | Meaning |
| --- | --- |
| `--account <origin>` (`LEVELCODE_WEB_ACCOUNT`) | The LevelCode Cloud origin: where sign-in happens, and where the gateway is. Baked into `index.html`. |
| `--api-url <origin>` (`LEVELCODE_WEB_API_URL`) | Only when the API is not on the account origin (production has one host for both): a local account site with the backend behind a tunnel, say. The gateway must be `https`. |
| `--webview-origin 'https://{{uuid}}.view.example.com'` (`LEVELCODE_WEB_WEBVIEW_ORIGIN`) | Self-host the webview origin. Without it the page uses Code-OSS's CDN at this build's own commit. Needs wildcard DNS and TLS — see below. |
| `--ext-host-origin 'https://{{uuid}}.ext.example.com'` (`LEVELCODE_WEB_EXTHOST_ORIGIN`) | Run the extension host on an origin of its own. Optional while no third-party code is loaded. |
| `--static <dir>` | Use a prebuilt client (skips the gulp build). |
| `--id <id>` | Override the build id (default: a fingerprint of the client, the page and the extension). |

**Dev server** (`web/serve.mjs`): `--static <vscode-web dir> --extensions <dir> --extension-names
levelcode-ai,levelcode-web --account <origin>`, plus `--product <json>` and `--config-defaults
<json>` to override the product configuration. The extension is built with
`node web/ai-extension/build.mjs --out <dir> --vscode <checkout>`.

**Release layout.** `index.html` and the callback page are at the root, un-cached. Everything
else is under `/_/<id>/` and cached for a year (`immutable`): `static/` (the client), `extensions/`,
`main.js`, `boot.css`. A cold first load fetched about 20 MB uncompressed (5 MB gzip) over 147
files from the editor's origin, plus the webview host page from the CDN; the whole directory is
about 195 MB, most of it grammars and extensions the page does not request until they are used.
(Measured as the size of the files the page asked for, not as bytes on the wire.)

## Deploying

It is a static site. What the host must supply:

### Three origins, and which is optional

| Origin | Default | Why it is separate |
| --- | --- | --- |
| **Editor** — `index.html`, `callback.html`, `/_/…` | the host you deploy to | The only origin that holds the session. |
| **Webview** — where the chat panel (and every webview) runs | `https://{{uuid}}.vscode-cdn.net`, Code-OSS's CDN at this build's own commit | Webview content must not share the editor's origin. **Each webview needs its own subdomain**, so a self-hosted origin has to be a wildcard (`*.view.example.com` with a certificate for it); a single host fails with "Expected '<id>' as hostname or subdomain". |
| **Extension host** — the iframe the worker runs in | the editor's own origin | Isolating it (`--ext-host-origin`, a wildcard likewise) puts third-party extension code on a different origin than the session. Not needed while only LevelCode's extensions load. When it is on, **every** `fetch` an extension makes carries that origin, so the API's CORS must allow it. |

### Headers

`dist-web/_headers` (Netlify, Cloudflare Pages) and `dist-web/deploy/nginx.conf` carry the same
policy; `web/serve.mjs --dist` reads the same file, so the end-to-end checks run under it. The
Content-Security-Policy for the editor is the tightest the workbench allows:

- `script-src 'self' 'unsafe-eval' blob:` — Monaco and the TextMate/WASM engines compile code at runtime;
- `connect-src 'self' https: http://localhost:* http://127.0.0.1:*` — a provider key is used from the tab, to the
  provider the user chose; loopback is the one place a browser allows plain http from an https page, for a
  model server on the user's own machine (an OpenAI-compatible endpoint through the custom provider — *not run*);
- `frame-src 'self' <webview origin> [<ext-host origin>] data:`; `object-src 'none'`, `base-uri 'none'`,
  `form-action 'none'`, `frame-ancestors 'none'`.

The callback page has `default-src 'none'` and only its own script and style.

### On the account site

Three settings on the Rails app (all default **off**; with none set nothing changes):

| Variable | Meaning |
| --- | --- |
| `LEVELCODE_WEB_EDITOR_ORIGINS` | Comma list of origins the editor is served from, exactly (`https://editor.example.com`). A sign-in code is only ever sent to `<origin>/callback.html` with the right parameters. Also the CORS list. |
| `LEVELCODE_WEB_EDITOR_URL` | Where the account site's "Open LevelCode" goes: one of those origins and, optionally, a path. |
| `LEVELCODE_WEB_EXTENSION_HOST_ORIGINS` | Comma list (one wildcard each) of origins the extension host runs on, when isolated. CORS only — never a callback. |

`GET /api/levelcode/v1/web_editor` answers `{ enabled, url }`; the account SPA shows its entry
points only when it is on.

**Do not host the editor on a subdomain of the account host.** The account session cookie is
`SameSite=Lax`, which is a site boundary, not an origin one: it is sent on a request from a sibling
subdomain, and the API takes that cookie when there is no bearer token. A page that runs other
people's extensions there could cause credentialed requests (CORS stops it *reading* the answer, not
causing the effect). Use another registrable domain.

## Security model

- **The session is the user's tokens.** They are in SecretStorage, which in a tab is sealed with
  AES-GCM under a **non-extractable** key kept in IndexedDB, and stored in localStorage. That keeps
  tokens out of a localStorage dump, a backup or a copied profile. It is **not** a defence against
  script running on the editor's origin, which can use the same key — so **the page loads no
  third-party extension** (`extensionsGallery: null`) and nothing is installed into its origin.
- **The store belongs to every tab.** The refresh token is rotated on use; a tab that cached it
  would present a token another tab had rotated away and end a session the other just renewed. Reads
  go to storage each time and a change is read-modify-write of one key under a Web Lock.
- **One command, one destination** — `levelcode.web.openAuthUrl` (above).
- **A sign-in code is only handed to a listed origin, to the exact callback page**, by the backend;
  the page then takes it out of the address bar (`history.replaceState`) and storage.
- **Keys of the user's own** (BYOK) are stored the same way and used from the tab to the provider the
  user chose; no LevelCode call is involved (the end-to-end check asserts it). The provider must
  accept requests from a web page; Anthropic's is called with its browser-access header.
- **The scratch workspace and the extension's private state are on the extension host's origin**, in
  IndexedDB. With the host isolated they are not readable from the editor's page, by design.

## Where state lives

| What | Where | Notes |
| --- | --- | --- |
| Session tokens, BYOK keys | localStorage `levelcode-web.secrets.v1` (sealed); the key in IndexedDB `levelcode-web` → `keys` | editor origin; shared by tabs |
| Sign-in result in flight | localStorage `vscode-web.url-callbacks[N]`; sessionStorage `levelcode-web.return` | removed when read |
| Scratch workspace | IndexedDB `levelcode-scratch` → `nodes` | extension host origin; changes are broadcast to other tabs |
| Chat sessions, memory, images | IndexedDB `levelcode-ai-fs` → `files`, loaded at start | extension host origin; a change made in another tab shows after a reload |
| Editor settings, layout | the workbench's own storage | editor origin |

Clearing the browser's site data removes all of it. A private window may discard it on close; the
secret store then falls back to memory for the session.

## Keeping the desktop and the browser in step

- **A new tool that needs a shell, a disk or a local process** declares it: add the tool name to
  `NEEDS_SHELL` (or gate on `host.caps`) in `agent.js` so the browser neither offers nor promises it.
  The browser system prompt is built from the same `SYSTEM_LINES`.
- **A new workspace read or write goes through `host`.** `fs` on a workspace path would work on the
  desktop and quietly do nothing in a tab. `extensions/levelcode-ai/test/` and `web/test/unit/` check
  the places this has bitten.
- **Copy that is true on a Mac and false in a tab** (keychain, "your machine") is rewritten by
  `web/ai-extension/copy.js`, which **fails the build** when the desktop text it expects is gone. Update
  the desktop and `copy.js` together.
- **`web/ai-extension/manifest.js`** removes the commands and settings a tab cannot honour. A new
  command that shells out belongs in `REMOVED_COMMANDS`.
- **A Code-OSS bump** can change the web client's packaging and the webview service worker's version;
  rebuild and run the end-to-end checks. The webview template names this build's own commit
  (`{{quality}}/{{commit}}`) for that reason.

## Tests

| Check | Command | What it proves |
| --- | --- | --- |
| Unit gate | `./scripts/test-extensions.sh` | Includes `web/test/unit/*.test.js`: the shims against Node, `host.js` on both sides, `main.js`'s functions (address check, delivery, the shared secret store, `?signin=1`), the manifest, the copy rewrites. Runs in CI on every PR (`test.yml`). Also run on Linux / Node 18 in a container with the network refused. |
| End to end | `node web/test/e2e.mjs --dist dist-web --stub-port <port the build used>` | Real headless Chrome: boot from static files, the extension activates in the worker, sign in through the real callback page, agent tool calls (write / list / search / read / edit) against the scratch workspace, Quick Open, Keep and Undo, a reload that keeps the session and files. |
| Same-tab sign-in | `node web/test/e2e-signin-tab.mjs --dist dist-web --stub-port <port>` | No second window; verifier survives the reload; no repeat; no sign-in for a signed-in editor; a second tab uses the same session; a stranded result is delivered, an old one dropped. |
| Bring your own key | `node web/test/e2e-byok.mjs --static … --extensions …` | The request goes from the tab to the provider with the user's key and nothing of LevelCode's. |

The end-to-end checks use a **stand-in backend** (`web/test/stub-backend.mjs`, HTTPS with a
throwaway certificate) that applies the same redirect and CORS rules the real one must. They prove
the editor's half of the contract; the backend's half is its own specs. The hand-written CDP driver
needs Node 22+ and a Chrome (`CHROME=` to point at one).

The checks were run against a release served with its own `_headers` (same-origin extension host, the
webview from Code-OSS's CDN), and against the development server with the webview and the extension
host on origins of their own (`--product` with `webviewContentExternalBaseUrlTemplate` and
`webEndpointUrlTemplate`).

### Trying it yourself, against a real backend

The repo's checks use a stand-in for the account site. To use the real one, locally:

1. **Backend** — the thin.ly branch with the web edition, its usual dev server and https tunnel, plus
   `LEVELCODE_WEB_EDITOR_ORIGINS=http://localhost:8800` and `LEVELCODE_WEB_EDITOR_URL=http://localhost:8800/`.
   (The gateway refuses plain http, so the editor's API host has to be the tunnel.)
2. **Account site** — the onetime branch: `npm run dev` (it proxies to the backend), at `http://localhost:5173/ai`.
3. **Editor:**

   ```bash
   node scripts/build-web.mjs --account http://localhost:5173 --api-url https://<your tunnel> --out dist-web
   node web/serve.mjs --dist dist-web          # http://localhost:8800
   ```

4. **What to do, and what you should see:**
   - Signed out everywhere: open `http://localhost:8800/?signin=1`. The tab goes to the account site's
     sign-in page ("Connect the editor to your account…"). Sign in with an email code. The tab comes back to
     the editor with a clean address, a "Signed in to LevelCode." message, and the model and plan in the chat footer.
   - Signed in on the account site first: open `http://localhost:5173/ai/account` and use **Open in browser**.
     The editor opens, the tab flashes through the login page ("Opening LevelCode…") and is back signed in,
     with nothing typed.
   - Ask the agent: *Create a file named hello.txt containing: hello.* The file appears in the Explorer.
   - **LevelCode: Open Folder from Your Computer…** (palette) in Chrome or Edge: pick a folder, ask the agent
     to read a file of it and write another.
   - A second tab of the editor opens already signed in (it shares the session).

Look at the browser's network panel while you do it: every call to the API should be `200`, with no CORS
errors in the console. A CORS error means the editor's origin is not in `LEVELCODE_WEB_EDITOR_ORIGINS`.

This was run once, by a hand-driven script, against Rails from the thin.ly branch in test mode (email and
Stripe stubbed, a throwaway database): email-code sign-in from the editor, sign-in from an already
signed-in browser, a gateway chat, the agent writing a file, and a folder opened through a real
`FileSystemDirectoryHandle` (the origin-private file system stands in for the OS picker). That script needs
the other repository's internals and is not part of this repo's checks.

### What was not run

Say these out loud rather than discover them in production:

- **A real browser other than headless Chrome.** Safari and Firefox are untested; so are phones.
- **The operating system's folder picker itself.** It needs a person. Everything after it — the command, the
  workbench's `file` provider on a real `FileSystemDirectoryHandle`, the agent's list, read and write — is run
  (`web/test/e2e.mjs` section 5), with the origin-private file system standing in for the picker. Permission
  handling on a *persisted* handle after a reload (the browser asks again) is the browser's and was not run.
- **A production account site.** The real sign-in page and Rails were run locally (above), not the deployed
  ones; the backend's rules are its own specs.
- **Another provider's CORS.** Anthropic's browser-access header is set; whether a given provider
  answers a page's request is that provider's.
- **Production hosting:** DNS, a wildcard certificate, the CDN in front, the real headers on the real host.
- **Long sessions across the 8-hour access-token boundary in a tab** (the logic is the desktop's,
  unchanged; the shared store was added for it and is unit-tested, not soaked).

## Decisions that are the owner's

1. **The editor's domain.** Not a subdomain of the account host (see Deploying). Which registrable
   domain, and who holds it.
2. **The webview origin.** Keep Code-OSS's CDN (no setup; a dependency on Microsoft's hosting of the
   published page for this build's commit) or self-host a wildcard origin.
3. **Isolating the extension host.** Worth it before any third-party extension is ever allowed; not
   needed while the page loads only LevelCode's.
4. **Where the entry points point.** Today every "Open LevelCode" link carries `?signin=1`, so the
   editor starts the sign-in itself. Whether visitors who are not signed in at the account site
   should see the editor first instead.
5. **Support statement.** Chrome and Edge for folders; scratch workspace everywhere else; phones
   unstated until run.
