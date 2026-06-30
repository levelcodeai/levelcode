# Atom++ reference Settings Sync server

A tiny, **dependency-free** implementation of the Code-OSS user-data-sync REST contract — the
same protocol the editor's built-in **Settings Sync** speaks. See
[`docs/atompp-sync-design.md`](../../docs/atompp-sync-design.md) for the full design.

It exists to:
- **develop/test** Atom++ Sync end-to-end with no cloud backend, and
- **self-host the free sync tier** (bring your own storage).

Atom++ Cloud (thin.ly) implements the same contract for managed **Pro** sync.

## Run

```bash
PORT=9595 node tools/sync-server/server.js
# → Atom++ reference sync server on http://localhost:9595
```

`branding/product.overlay.json` → `configurationSync.store.url` points the editor here
(`http://localhost:9595`) for dev. **Before release, point it at the managed Atom++ Cloud host.**

## Test

```bash
node tools/sync-server/test.js     # round-trips the REST contract (manifest, ETags, isolation)
```

## Contract (implemented)

| Method · Path | Behavior |
|---|---|
| `GET /v1/manifest` | `{ session, ref, latest: { <type>: <ref> }, collections: {} }`; `If-None-Match` → `304` |
| `GET /v1/resource/{type}/latest` | content + `ETag`; `If-None-Match` → `304`; none → `204` |
| `POST /v1/resource/{type}` | write; `If-Match` precondition → `412` on mismatch; returns new `ETag` |
| `GET /v1/resource/{type}/{ref}` | a historical version |
| `GET/POST/DELETE /v1/collection[...]` | minimal (no real profiles in v1) |

## Notes

- **Auth:** every `/v1` request needs `Authorization: Bearer <token>` (the token comes from the
  `atompp` auth provider in `extensions/atom-sync`). Storage is **isolated per token**.
- **Opaque bodies:** the server never parses settings, so client-side **E2E encryption** can be
  added later with zero server changes.
- **Dev only:** HTTP on localhost, file-backed storage under `tools/sync-server/.data` (gitignored).
  Not hardened for production — thin.ly is the managed implementation.
