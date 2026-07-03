# Atom++ reference update-feed server

A tiny, **dependency-free** implementation of the Code-OSS update-feed contract that both the
built-in updater and the **notify-only `atom-updater` extension** speak.

```
GET /api/update/{target}/{quality}/{commit}
   → 204   if {commit} is already the latest build
   → 200   { version, productVersion, url, sha256hash, timestamp, releaseNotesUrl }
```

## Run

```bash
cp tools/update-server/releases.example.json tools/update-server/releases.json   # edit it
PORT=9696 node tools/update-server/server.js
```

`releases.json` declares the latest build per `target`+`quality`:

```jsonc
{
  "darwin-arm64": {
    "stable": {
      "commit": "<latest build's 40-hex git sha>",
      "productVersion": "0.2.0",
      "url": "https://cdn.atompp.ai/rel/Atom++-0.2.0-arm64.zip",
      "sha256hash": "…",
      "timestamp": 1751212800000,
      "releaseNotesUrl": "https://atompp.ai/releases/0.2.0"
    }
  }
}
```

## Test the notify-only flow end-to-end

1. `node tools/update-server/server.js` (terminal 1).
2. In the editor settings: `"atompp.update.url": "http://localhost:9696"`.
3. Run **Atom++: Check for Updates** — if your running `product.commit` differs from `releases.json`'s, you get a **"Atom++ 0.2.0 is available — Download"** notification.

## Test (automated)

```bash
node tools/update-server/test.js     # 5 contract round-trips
```

## Notes

- **Notify-only:** the `atom-updater` extension only links to the download — it never installs.
  Native auto-apply needs Developer-ID signing (the built-in Squirrel updater); this works on any build.
- **Dev only:** HTTP on localhost. Atom++ Cloud is the managed implementation; staged
  rollout / channels live there.
