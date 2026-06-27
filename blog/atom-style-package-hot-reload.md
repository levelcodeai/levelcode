---
title: "Bringing Back Atom's Magic: Live Package Hot-Reload in Atom++"
date: 2026-06-26
tags: [atom-plus-plus, editor, hackability, developer-experience]
---

# Bringing Back Atom's Magic: Live Package Hot-Reload in Atom++

![Hero: editing a package and watching the status bar update live, no reload](./images/hot-reload-hero.gif)
<!-- HERO GIF (the money shot, ~6-10s, loop):
     Split view — extension.js on the left, status bar visible at the bottom.
     Change item.text in code, hit save, status bar updates instantly. Repeat 2-3 times
     with different values so the loop reads clearly. Keep it tight and looping.
     Suggested size: ~1200px wide. -->

There was a particular kind of joy in hacking on Atom. You'd open `init.coffee`, write a
few lines, and your editor would *change* — right there, while you were using it. No
rebuild, no restart, no second window. The editor was clay, and it was warm.

When Atom was sunset, that feeling mostly went with it. Modern editors are fast and
powerful, but extending them tends to mean: scaffold a project, press F5, wait for a second
"Extension Development Host" window to boot, make a change, then reload that window to see
it. It works. It's just… cold. The loop is long enough that you stop experimenting.

So while building **Atom++** — an AI-native, hackable editor on the VS Code core — I wanted
that warmth back. Two commands now do it:

- **`Atom++: Generate Package…`** — scaffold a real, runnable package in one step.
- **`Atom++: Develop Package (Hot Reload)…`** — load it into the editor you're *already
  using*, and re-run it every time you save.

Here's what that feels like, and how it works.

## The loop, in ten seconds

Open the command palette and run **`Atom++: Generate Package…`**. Type a name —
`hello-atom`.

![The Generate Package command in the command palette with the name prompt](./images/generate-package-palette.png)
<!-- SCREENSHOT: command palette open showing "Atom++: Generate Package…" (or the name
     input box with "hello-atom" typed). Crop to the palette + a bit of editor for context. -->

Atom++ scaffolds a complete package:

```
~/.atom-plus-plus/packages/hello-atom/
├── package.json        # manifest + a sample command
├── extension.js        # activate() / deactivate()
├── README.md
└── .vscode/launch.json # for the full F5 dev host, when you need it
```

It opens `extension.js` and offers a button: **Develop (Hot Reload)**. Click it.

A `● dev: hello-atom` indicator lights up in the status bar, a `🚀 hello-atom` item appears,
and your sample command is live.

![The status bar showing the live dev indicator and the package's own status item](./images/dev-status-bar.png)
<!-- SCREENSHOT: zoom on the status bar — the "● dev: hello-atom" indicator next to the
     "🚀 hello-atom" item. A tight horizontal crop of just the status bar reads best. -->

Now the good part: change the status text in
`extension.js`, hit save, and watch the status bar update **instantly**. No window reload.
No flicker. The editor just becomes the new version of itself.

```js
function activate(context) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  item.text = '$(rocket) hello-atom';   // ← change this, save, watch it update live
  item.show();
  context.subscriptions.push(item);
}
```

![GIF: editing item.text, saving, and the status bar item changing with no reload](./images/save-to-update.gif)
<!-- GIF (close-up of the moment, ~4-6s, loop): show the cursor editing item.text from
     '$(rocket) hello-atom' to something else, Cmd+S, and the status bar item swapping
     text immediately. This is the core "wow" — keep it focused on code + status bar. -->


That's the Atom loop. Write, save, see it. The distance between an idea and a working
change collapses to almost nothing — which is exactly when you start trying things you
otherwise wouldn't.

## How it works

VS Code's extension model loads each extension **once**. That's the right call for stability,
but it's why the normal dev story is "reload the whole window." To get true hot-reload, you
have to step outside that model a little — carefully.

Atom++ runs a small **dev loader** inside the running window. When you start developing a
package, it does three things:

**1. Loads your code into the live editor.** Instead of registering your package as a
formal extension, it compiles `extension.js` as a fresh module and calls its `activate()`
directly — handing it a context object with a `subscriptions` array, just like the real
extension API. Crucially, it wires the bare `require('vscode')` call to the real editor API,
so your package talks to the actual editor it's running inside:

```js
const m = new Module(mainPath, null);
m.require = (id) => (id === 'vscode' ? vscode : baseRequire(id));
m._compile(fs.readFileSync(mainPath, 'utf8'), mainPath);
return m.exports; // -> { activate, deactivate }
```

Building a *new* module each time is also what makes reloads clean: there's no stale cached
copy to fight with.

**2. Watches the folder and re-runs on save.** A recursive file watcher fires on every `.js`
change, debounced by 150ms so a burst of saves collapses into one reload. Each reload tears
down the previous run before starting the next — it calls your `deactivate()` and disposes
every subscription your last `activate()` registered, so status items, commands, and event
listeners don't pile up:

```js
function reload() {
  teardown();        // deactivate() + dispose all previous subscriptions
  activatePackage(); // fresh module, fresh activate()
}
```

That dispose-then-reactivate cycle is the whole trick. Because the editor's API hands back a
disposable for everything you create, "undo the last version" is just "dispose what it
registered." Hot-reload becomes a bookkeeping problem, not a magic one.

**3. Fails safely.** If your edit has a typo, the reload is caught: you get a one-line error
toast and a full stack trace in an "Atom++ Packages" output channel, while the editor keeps
running. Fix the typo, save, and it recovers on the next reload. You never lose your session
to a bad keystroke — which, again, is what makes you brave enough to experiment.

![A caught reload error: the error toast plus the stack trace in the output channel](./images/reload-error.png)
<!-- SCREENSHOT (optional but nice): introduce a deliberate typo, save, and capture the
     error toast + the "Atom++ Packages" output channel showing the stack trace. Shows the
     editor survived a broken edit. -->


## The honest part

This isn't sorcery, and it has an edge. Hot-reload runs your package's **runtime code** —
the body of `activate()`, where Atom-style packages did most of their work: registering
commands, adding UI, reacting to events. That covers a lot.

What it can't hot-swap is anything declared **statically in the manifest** — keybindings,
menus, settings schemas contributed via `package.json`. Those are read when an extension
loads, not when its code runs. For those, the generated `.vscode/launch.json` is right
there: press **F5** for a full Extension Development Host. The two paths complement each
other — live-reload for the fast inner loop, F5 for the manifest-level stuff.

I think being clear about that boundary matters more than pretending it doesn't exist. The
goal was never to fake Atom; it was to bring back the part of Atom that made the editor feel
*alive* — and that part is the inner loop.

## Why this matters

Tooling shapes behavior. When extending your editor means a 20-second round trip, you do it
rarely and deliberately. When it means save-and-see, you do it constantly, casually,
playfully. You write a tiny command to scratch an itch. You tweak a status bar to show the
thing you actually care about. You make the editor *yours* — which was always the whole
point of Atom.

Atom++ is a bet that an editor can be both modern (the VS Code core, native AI, real
performance) and warm (hackable, scriptable, live). Package hot-reload is a small feature,
but it's the one that, the first time it worked, genuinely felt like the Atom golden days
again.

Write, save, see it. Welcome back.

---

*Atom++ is an AI-native, hackable, Notepad++-powered editor for macOS, built on the MIT
Code-OSS core. The package generator and hot-reload loader live in the `atom-hackability`
extension, alongside the user init script and the Atom/Notepad++ keymap presets.*
