# URL Shortener — Design

> **Status:** Draft v0.1 · **Date:** 2026-07-03 · **Scope:** Reference design for a scalable, resilient URL shortening service.

## 1. Goals & Non-Goals

### Goals
- Convert a long URL into a short, unique, shareable token.
- Redirect a short token to the original URL with minimal latency.
- Deduplicate identical long URLs to the same short token.
- Provide basic analytics: click count, last used time, referrer summary.
- Support custom aliases (optional / Pro).
- Expose a simple REST + lightweight web UI.

### Non-Goals
- Full-blown analytics dashboard (keep stats lightweight).
- Advanced bot/spam filtering beyond URL validation.
- Monetization tiers in this design.

## 2. Core API

Base path: `/v1`

| Method · Path | Request | Response | Notes |
|---|---|---|---|
| `POST /v1/shorten` | `{ url, alias?, ttlDays? }` | `{ shortUrl, token, expiresAt? }` | `400` if invalid URL; `409` if alias taken. |
| `GET /{token}` | — | `302` redirect to original URL | `404` if token unknown/expired; `410` if expired. |
| `GET /v1/info/{token}` | — | `{ url, createdAt, clicks, lastUsedAt, expiresAt? }` | 404/410 same as redirect. |
| `DELETE /v1/shorten/{token}` | `Authorization: Bearer <token>` | `204` | Optional ownership check if tokens are user-scoped. |

## 3. Short Token Generation

### Encoding
- Generate a **monotonically increasing 64-bit integer** (e.g., database auto-increment or Snowflake-ish ID).
- Encode it with a **Bijective base-62** alphabet: `0-9A-Za-z`.
- Start token length at 5 characters (~916 million tokens) and grow naturally as IDs increase.

### Deduplication
- Compute a deterministic hash of the normalized long URL (SHA-256 truncated).
- Query an index table/hash before minting a new token.
- If the URL already exists, return the existing token.

### Aliases
- Accept custom aliases directly when provided and unique.
- Reserve a separate table key-space so aliases never clash with auto-generated tokens.
- Reject aliases matching a block-list or shorter than a minimum length.

## 4. Data Model

### Primary table: `urls`
| Field | Type | Notes |
|---|---|---|
| `id` | `BIGINT` PK | Auto-increment internal ID, not exposed. |
| `token` | `VARCHAR(16)` UNIQUE | Base-62 encoded id or custom alias. |
| `url_hash` | `BINARY(32)` | SHA-256 of normalized URL for dedup. Indexed. |
| `long_url` | `TEXT` | Original URL (validated). |
| `created_at` | `TIMESTAMP` | Defaults to `now()`. |
| `expires_at` | `TIMESTAMP?` | NULL means no expiry. |
| `click_count` | `BIGINT` | Approximate via counter increment; flushed batch/async. |
| `last_used_at` | `TIMESTAMP?` | Updated asynchronously. |

### Index table: `url_hash_lookup`
| Field | Type |
|---|---|
| `url_hash` | `BINARY(32)` PK |
| `token` | `VARCHAR(16)` |

## 5. Read vs. Write Optimization

Redirects dominate read traffic. Optimize the hot path:
1. **Token → long URL is the only query on the redirect path.**
2. Return a minimal response (just issue `Location:` header).
3. Cache heavily:
   - **In-memory near the edge:** Varnish / Cloudflare / Fastly caches `302` responses with aggressive TTL (e.g., 1h).
   - **Redis / Memcached:** token → long_url, TTL 1h. Cache miss hits the DB.

### Asynchronous analytics
- Redirects should not wait for stats writes.
- Queue events (token, timestamp, referrer, country) to Kafka / SQS / Redis Streams.
- Aggregate counters and `last_used_at` in a background worker.
- Accept small counter loss (eventual consistency) rather than slow the redirect.

## 6. Scaling

- **Database:** start with a single primary + read replicas. Replicas handle reads; primary handles writes. Scale horizontally by sharding on `token` once needed.
- **ID generation:** avoid DB auto-increment if you expect very high write throughput. Use a Snowflake/KSUID-like scheme instead, then base-62 encode.
- **Rate limiting:** per-IP and per-account limits on `/v1/shorten`; per-token rate limiting can prevent abuse.
- **Expiry / cleanup:** a scheduled worker deletes expired rows and invalidates matching cache entries.

## 7. URL Safety

- Validate scheme: allow only `http://` and `https://`.
- Reject URLs resolving to private IP ranges (SSRF protection on validation, not redirect).
- Optional malware/phishing blacklist lookups asynchronously; surface warning interstitial.
- Add `rel="nofollow"` and robots no-index headers.

## 8. Deployment Sketch

```
CDN / Edge cache (302 redirects)
        │
   API / Redirect gateway (stateless, auto-scaled)
        │
   Redis cache cluster
        │
   Primary DB  ──► Read replicas
        │
   Analytics queue ──► background workers
```

## 9. Failure Modes

| Scenario | Mitigation |
|---|---|
| Cache cold start | Read replica handles burst; warm cache from DB lazily. |
| DB primary down | Defer new shortening; serve redirects from CDN/cache. Fail fast on writes. |
| Token collision | Generative IDs + unique constraints; aliases checked atomically. |
| Expired token still cached | Use cache TTL ≤ expiry window; include invalidation event on cleanup. |
| Abuse / spam | Rate limits, block lists, CAPTCHA on web UI, abuse reports. |

## 10. Future Improvements

- Signed short URLs (tamper-proof tokens with HMAC).
- QR-code generation endpoint.
- A/B test / georedirect rules per token.
- Custom domain support (CNAME + token suffix lookup).
