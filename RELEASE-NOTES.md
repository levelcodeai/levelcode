# LevelCode v1.0.1

A reliability patch. A transient upstream hiccup now **retries and recovers** instead of killing your run, and when something does fail you get an **honest, readable** message rather than a wall of proxy HTML mislabeled "OpenAI".

## Highlights

### Runs survive a transient upstream blip

When the model gateway briefly can't reach a healthy backend it returns a **502 / 503 / 504** — a momentary hiccup that used to end the whole run. LevelCode now **retries once, before anything has streamed**, so the common case (the backend is fine a second later) just recovers and your turn carries on. You'll see a brief `upstream busy — retrying…` instead of a dead run.

It's deliberate about *when* it retries: only a genuine transient 5xx, and only before any output has appeared — so a retry can never duplicate text or double-charge. It does **not** retry a rate-limit (429), a real request error (500 / other 4xx), or an aborted request, and a 401 still refreshes your session as before. Hitting **Stop** during the wait stays instant.

### Honest error messages

A gateway failure used to land in the chat verbatim, like this:

```
OpenAI API 502: <html><head><title>502 Bad Gateway</title></head><body>…
```

Two things were wrong: it was labelled **OpenAI** even for an Anthropic model on your LevelCode Cloud plan, and it pasted the raw nginx error page into the transcript. The same failure now reads:

```
LevelCode Cloud API 502: Bad Gateway
```

The route is named correctly — LevelCode Cloud, OpenRouter, or whichever provider actually handled it — and the body is parsed for a real message. An HTML proxy page carries none, so it falls back to the plain status reason instead of being dumped in.

## Under the hood

- The repository's `LICENSE` is now recognised as **MIT** by GitHub. The MIT text is kept verbatim so the detector matches it, the Code-OSS provenance + trademark notice moved to a dedicated `NOTICE` file, and the in-app license link points at a branch that exists (`HEAD`) rather than a `main` that never did (it had been a 404).

## Test coverage

- **24 suites** across the bundled extensions, all green on every release.
- `providers.test.js` grew to **28 cases**: the error sanitiser (a real nginx 502 page collapses to `Bad Gateway`, a JSON `{error:{message}}` is preserved, the label names the route — not the adapter) and the retry (recovers on a 502-then-200, gives up cleanly after one try, never retries a 4xx or an abort). The retry is also exercised end-to-end against a stubbed stream, so the whole router → adapter path is covered, not just the helper.

**Full changelog:** https://github.com/levelcodeai/levelcode/compare/v1.0.0...v1.0.1
