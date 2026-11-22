# Design

This document explains the design behind the [README](../README.md): how Temporal and Redis are used, the decisions and assumptions made along the way, and what we'd change for production.

- [Why Temporal](#why-temporal)
- [Redis data model](#redis-data-model)
- [Design decisions and assumptions](#design-decisions-and-assumptions)
- [Known limitations and possible improvements](#known-limitations-and-possible-improvements)

## Why Temporal

### Workflow vs activities

Temporal replays workflow code from its event history, so that code has to be **deterministic**. Every replay must make the same decisions in the same order. [src/temporal/workflows.ts](../src/temporal/workflows.ts) therefore contains only orchestration and the pure function `selectBestOffers`. It never makes HTTP calls, touches Redis, reads the clock, generates random numbers, or imports config or the logger. It refers to the activities with `import type` only, so activity code never ends up in the workflow sandbox bundle.

All I/O lives in [src/temporal/activities.ts](../src/temporal/activities.ts):

| Activity | Does |
|---|---|
| `fetchSupplierA(city)` / `fetchSupplierB(city)` | HTTP GET to `{SUPPLIER_BASE_URL}/supplierX/hotels?city=` with a 4s per-attempt timeout, then validates the payload with zod |
| `saveToRedis(city, offers, failedSuppliers)` | Atomic `MULTI` write (see [Redis data model](#redis-data-model)) |

The workflow ID (`hotel-offers-{city}-{uuid}`) is generated in the API, never inside the workflow.

### Parallel calls

Both supplier activities are scheduled in the same workflow task through `Promise.allSettled([fetchSupplierA(city), fetchSupplierB(city)])`, so they run at the same time. `allSettled` rather than `all` means one supplier failing never cancels the other.

### Retry policy and timeouts

| Scope | startToCloseTimeout | Attempts | Backoff |
|---|---|---|---|
| Supplier activities | 5s | 3 | 500ms, ×2 (500ms, then 1s) |
| `saveToRedis` | 3s | 2 | 200ms |
| Workflow execution | 30s | — | — |

Worst-case budget: each supplier activity can take 3 × 5s + 0.5s + 1s = 16.5s (the two run in parallel), and the save can take 2 × 3s + 0.2s = 6.2s, for a total of about 22.7s. That stays under the 30s workflow limit, so a slow supplier can never push the workflow into a timeout. The save gets a deliberately short policy for the same reason. The API waits at most 3s for the workflow to start and 35s for its result.

### Partial and total failure

- **HTTP errors and timeouts** are plain errors, so Temporal retries them.
- **A malformed payload** (non-JSON, or failing the zod schema) raises a non-retryable `ApplicationFailure` of type `InvalidSupplierResponse`. Retrying can't fix bad data, so it counts as that supplier failing straight away.
- **One supplier fails** after its retries: the workflow carries on with the other supplier's offers and returns `{ offers, failedSuppliers, cached }`.
- **Both fail**: the workflow throws a non-retryable `ApplicationFailure` of type `AllSuppliersFailed`, with each supplier's error in `details`. The API maps it to `503 ALL_SUPPLIERS_FAILED`.
- **`saveToRedis` fails** after its retries: the workflow logs a warning and still succeeds with `cached: false`. The API then returns the live result (`X-Cache: BYPASS`), or `503 CACHE_UNAVAILABLE` if a price filter was requested.

Each attempt, retry and failure shows up in the Temporal UI (<http://localhost:8233>) and in the structured pino logs, which include the supplier, city, attempt number and duration.

## Redis data model

Each city gets three keys, written together and expiring together ([src/redis/hotelRepository.ts](../src/redis/hotelRepository.ts)). These are the real values for `delhi`:

| Key | Type | Contents |
|---|---|---|
| `hotels:delhi` | sorted set | member = hotel name, score = price |
| `hotels:delhi:details` | hash | field = hotel name, value = the offer as JSON |
| `hotels:delhi:meta` | string | `{"failedSuppliers":[]}` |

```text
> ZRANGE hotels:delhi 0 -1 WITHSCORES
Lemon Tree 3200 | Holtin 5340 | Radison 5900 | ITC Maurya 8800 | Taj Palace 9500

> HGET hotels:delhi:details Holtin
{"name":"Holtin","price":5340,"supplier":"Supplier B","commissionPct":20}
```

### Write (one transaction)

```text
MULTI
DEL     hotels:delhi hotels:delhi:details hotels:delhi:meta
ZADD    hotels:delhi 3200 "Lemon Tree" 5340 "Holtin" 5900 "Radison" 8800 "ITC Maurya" 9500 "Taj Palace"
HSET    hotels:delhi:details "Lemon Tree" '{...}' "Holtin" '{...}' ...
SET     hotels:delhi:meta '{"failedSuppliers":[]}' EX 300
EXPIRE  hotels:delhi 300
EXPIRE  hotels:delhi:details 300
EXEC
```

Clearing and rewriting everything inside one `MULTI` means a reader sees either the old list or the new one, never a mix. Any error inside `EXEC` counts as a failed save.

### Read

```text
MULTI
EXISTS        hotels:delhi
GET           hotels:delhi:meta
ZRANGEBYSCORE hotels:delhi 5000 6000        # missing bound → -inf / +inf
EXEC
HMGET         hotels:delhi:details "Holtin" "Radison"
```

A missing sorted set or meta key counts as a cache miss. If any detail is missing or corrupt (for example, it expired between the two round trips), the whole read counts as a miss and is never returned half-filled. A match with no results returns `[]` as a hit.

### Rules

- **TTL**: `CACHE_TTL_SECONDS` (300) when both suppliers succeeded. `PARTIAL_CACHE_TTL_SECONDS` (30) when either failed, so a recovered supplier shows up again quickly.
- **Empty results** skip the write completely. Nothing is cached, and the API returns `200 []` (`X-Cache: MISS`).
- **Filtering happens only in Redis**. Fresh results are read back through `ZRANGEBYSCORE` too, so cached and fresh responses come from the same code and are identical byte for byte.
- **The city is URI-encoded** in key names, so a city such as `a:details` can't clash with the keys of city `a`.
- **Persistence is off** (`--save "" --appendonly no`). Redis is a cache and the suppliers are the source of truth.

### Why a sorted set plus a hash

`ZRANGEBYSCORE` is a native inclusive range query over the score. It costs O(log N + M), runs on the server, and returns results already ordered by price and then by member name. That ordering is exactly the required sort, so no sorting happens in the application. The sorted set holds only names, so a hash holds each full offer, fetched in a single `HMGET`. The meta key keeps `failedSuppliers`, which lets a cache hit still send `X-Failed-Suppliers`. Storing the JSON directly as sorted-set members would make the member change whenever any field changed, and you couldn't look an offer up by name.

## Design decisions and assumptions

**Domain**

- **Name matching**: hotels are deduped on the name trimmed and lowercased, so `"Radison"`, `"  RADISON "` and `"radison"` are the same hotel.
- **Winning name**: the response uses the winning offer's own name, trimmed but with its original casing. That same string is the sorted-set member and the hash field. With Supplier A down, Delhi returns `"RADISON"` from Supplier B.
- **Ties** (same price): Supplier A wins. In the mock data, Mumbai's Trident is 7000 at both suppliers.
- **Duplicates within one supplier**: the cheaper offer is kept.
- **Sort order**: price ascending, then name in plain code-unit order (`a < b`, not `localeCompare`). This matches how Redis orders members with equal scores (byte order), so a fresh result and a cached one are always in the same order.
- **Commission**: `commissionPct` comes from the winning offer, and nothing else is merged in. Prices are assumed to be in one currency.

**API**

- **Response**: a bare array of `{ name, price, supplier, commissionPct }`, exactly the shape the assignment shows. Metadata goes in `X-Cache` (`HIT`, `MISS` or `BYPASS`) and `X-Failed-Suppliers`, never in an envelope around the array.
- **Cache-aside with a single read path**: on a hit, the API serves from Redis and skips the workflow. On a miss, it runs the workflow (which saves the result) and then reads back from Redis.
- **Redis down**: without a filter the API still answers from the workflow (`BYPASS`). With a filter it returns 503, because filtering must happen in Redis and is never done in application code.
- **Validation** (zod):
  - `city` is trimmed and lowercased, must not be empty, is at most 64 characters, and must be given once.
  - Prices must match a plain decimal (`^-?\d+(\.\d+)?$`) and be ≥ 0, which rules out `1e3`, `0x10`, `Infinity`, `.5` and `+5`.
  - An empty price counts as missing, not 0.
  - `minPrice` must be ≤ `maxPrice`, and both bounds are inclusive.
- **Errors**: always `{ "error": { "code", "message" } }`. Unexpected errors become `500 INTERNAL_ERROR`, and their details go to the logs only.
- **Workflow ID per request**: `hotel-offers-{city}-{uuid}`. Every request appears separately in the Temporal UI. The downside is that identical concurrent requests aren't merged into one (see [cache stampede](#known-limitations-and-possible-improvements)).

**Mock suppliers**

- **Where they run**: they live in the API process and are keyed by city. An unknown city returns `200 []`, and a random 200–400ms delay makes the parallel calls visible.
- **Simulating failure**: `SUPPLIER_A_DOWN` / `SUPPLIER_B_DOWN` (set on the API, because it serves the endpoints) or `?fail=true` return `500`. The worker reaches the endpoints through `SUPPLIER_BASE_URL` (`http://api:3000` in Compose).
- **The data itself** covers names that differ only in case or whitespace, an exact price tie, hotels unique to each supplier, and two cities.

**Health**

- **Checks**: `/health` runs five checks in parallel, each with its own 1s timeout, so a hung dependency is reported as `timeout` instead of blocking the response.
- **Sanitized errors**: error strings are short and fixed (`HTTP 500`, `unreachable`, `timeout`, `no worker polling task queue`, `check failed`). Hosts and stack traces go to the logs only.
- **Worker check**: the worker counts as up only if both its workflow and activity pollers were seen in the last 90s. Temporal keeps listing a stopped poller for several minutes, and an idle worker polls again at least every ~60s.
- **Liveness**: `/health/live` doesn't check any dependency. The Docker healthcheck uses it, so a Redis or supplier outage never gets the API container restarted.

**Redis client**

- **Fail fast**: the offline queue is turned off, and commands time out after 500ms in the API and 1s in the worker. A request never hangs on a Redis that's down, and the client keeps reconnecting in the background.
- **RESP2 pinned**: ioredis v6 defaults to RESP3 (`HELLO 3`), which fails against Redis older than 6 and brings no benefit here.

**Configuration**

- **Validation**: every env var is validated with zod at startup, and all problems are reported together. An empty value counts as unset.
- **`.env` file**: a local `.env` is loaded if one exists, but `.dockerignore` keeps it out of the image.

**Docker**

- **One image, two processes**: the API is the default `CMD` and the worker overrides the command. It's a multi-stage build with production dependencies only.
- **Base image**: `node:22-bookworm-slim`, not Alpine. `@temporalio/core-bridge` ships glibc native binaries only, so the worker can't load on musl.
- **Pre-bundled workflow**: `npm run build` runs `bundleWorkflowCode`, and the worker loads `dist/temporal/workflow-bundle.js`. That saves bundling at every start and keeps webpack out of the runtime path. In dev (`tsx`), the worker falls back to bundling from source.
- **Graceful shutdown**: exec-form `CMD ["node", …]` and `init: true` make sure SIGTERM reaches Node. `stop_grace_period: 15s` covers the API's 10s forced exit and the worker's 10s `shutdownGraceTime` plus cleanup.
- **Non-root**: the app runs as the `node` user and can read its files but not change them.
- **Healthcheck**: the slim image has no `curl`, so the API's healthcheck is a `node -e "fetch('http://127.0.0.1:3000/health/live')…"` one-liner.
- **Startup order**: the worker doesn't retry its first Temporal connection, so Compose starts it only once Temporal and Redis report healthy (`depends_on: service_healthy`) and restarts it if it exits (`restart: unless-stopped`).

## Known limitations and possible improvements

- **Cache stampede**: every request has its own workflow ID, so N requests that miss the same city at the same moment start N workflows and put N times the load on the suppliers. Correctness holds: the last `MULTI` wins and a reader never sees a half-written list. But a partial result (30s TTL) can overwrite a full one written a moment earlier. Two possible fixes:
  - Use a per-city workflow ID (`hotel-offers-{city}`) with `WorkflowIdConflictPolicy.USE_EXISTING`, so concurrent requests attach to the workflow already running.
  - Take a Redis `SET lock:{city} NX PX …` lock before starting the workflow, and have the other requests poll the cache until it's filled.
- **No worker running**: requests wait for the full 30s workflow timeout before returning `503 WORKFLOW_TIMEOUT`. The API could fail fast by checking for pollers before starting (as `/health` already does) or by using a shorter timeout.
- **Worker detection lag**: `/health` can keep reporting a crashed worker as `up` for up to ~90s, because of the poller freshness window.
- **Two round trips per read**: the `MULTI` and the `HMGET` are separate, and a write in between is handled by treating the read as a miss. A Lua script running `ZRANGEBYSCORE` and `HMGET` in one `EVAL` would make the read atomic and a single round trip.
- **Windows dev Ctrl+C**: `tsx watch` hard-kills the process on Windows, so the shutdown handlers don't run under `npm run dev:*`. To check graceful shutdown, run the compiled build (`npm run build && npm run start:api`) or use Docker.
- **Temporal dev server**: `temporal server start-dev` runs in memory as a single process. Workflow history is lost on restart, and there's no TLS or auth. In production, use Temporal Cloud or a self-hosted cluster with persistent storage (PostgreSQL or Cassandra), mTLS, and namespace retention policies.
- **Image size**: about 720 MB, mostly the Temporal native core-bridge and the Debian base. Running the API without the worker dependencies, or using a distroless runtime stage, would shrink it.
- **Coupled mock suppliers**: the suppliers run inside the API process, so if the API goes down the suppliers go with it. Real suppliers would be external services and would need their own circuit breakers.
- **Not covered**: authentication, rate limiting, pagination, and metrics or tracing (Temporal has OpenTelemetry interceptors).
