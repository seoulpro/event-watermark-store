# event-watermark-store

`event-watermark-store` keeps the newest event-time state for each key while a
terminal watermark prevents delayed events from restoring an already-ended
state.

It provides a pure decision function, an atomic provider contract, an in-memory
provider, a Redis Lua provider, and a small coalescing cache. The package has no
runtime dependencies and supports both ECMAScript modules and CommonJS on
Node.js 20.19 or newer.

## Ordering policy

Each key is absent, active at an event time, or terminal at an event time.

| Current record | Incoming transition | Result |
| --- | --- | --- |
| absent | any valid transition | `applied` |
| upsert at `T` | older than `T` | `stale` |
| upsert at `T` | upsert at `T` | `refreshed` |
| upsert at `T` | terminal at `T` | `applied` |
| terminal at `T` | time at or below `T` | `blocked-by-terminal` |
| any record | newer event time | `applied` |

Terminal therefore wins an equal-time race regardless of which receiver
executes first. A later upsert can intentionally resume the key.

## Install

```sh
npm install event-watermark-store
```

## Memory provider

```js
import { createEventWatermarkStore } from "event-watermark-store";
import { createMemoryEventWatermarkProvider } from "event-watermark-store/memory";

const provider = createMemoryEventWatermarkProvider({
  stateTtlSeconds: 300,
  terminalTtlSeconds: 7 * 24 * 60 * 60,
});
const store = createEventWatermarkStore({ provider });

await store.transition({
  key: "device-a",
  kind: "upsert",
  eventTime: 100,
  value: { reading: 42 },
});

await store.transition({
  key: "device-a",
  kind: "terminal",
  eventTime: 100,
  reason: "completed",
});
```

The same API is available through `require()`:

```js
const { createEventWatermarkStore } = require("event-watermark-store");
const {
  createMemoryEventWatermarkProvider,
} = require("event-watermark-store/memory");
```

## Transition results

Every transition returns:

```js
{
  status: "applied",
  accepted: true,
  changed: true,
  previous: null,
  current: { kind: "upsert", eventTime: 100 }
}
```

Statuses have fixed flag meanings:

| Status | `accepted` | `changed` |
| --- | ---: | ---: |
| `applied` | true | true |
| `refreshed` | true | true |
| `replayed` | true | false |
| `stale` | false | false |
| `blocked-by-terminal` | false | false |

An optional `operationId` classifies a retry of the current transition as
`replayed`. Identity covers kind, event time, value presence and content, and
reason presence and content. Reusing an ID with different identity throws
`OperationIdConflictError`. `receivedAt` is deliberately excluded so a retry
using a receiver clock can still replay. A replay does not extend TTL.

The memory provider fingerprints values with a canonical, type-aware encoding.
Values used with `operationId` cannot contain cycles, functions, symbols, or
custom class instances. Supported mutable values include arrays, plain objects,
dates, regular expressions, maps, sets, array buffers, and typed binary views.
They are snapshotted when stored and cloned on each read, so caller mutation
cannot change recorded operation content.

The Redis provider fingerprints the configured codec output. Its default JSON
codec sorts object keys recursively, so equivalent JSON content does not depend
on property insertion order. Custom encoders use exact string identity and must
return the same well-formed Unicode string for values the application considers
identical.

Trigger non-idempotent downstream work only when `changed` is true. The store
cannot make a database write, message publication, or HTTP response atomic with
its own provider transition.

## Redis provider

The Redis adapter accepts a structural script executor, so the package does not
depend on a particular Redis client:

```js
import { createEventWatermarkStore } from "event-watermark-store";
import {
  createIoRedisExecutor,
  createRedisEventWatermarkProvider,
} from "event-watermark-store/redis";

const provider = createRedisEventWatermarkProvider({
  execute: createIoRedisExecutor(redisClient),
  prefix: "events:",
  stateTtlSeconds: 300,
  terminalTtlSeconds: 604800,
});
const store = createEventWatermarkStore({ provider });
```

For node-redis, use `createNodeRedisExecutor(redisClient)`. Both helpers only
adapt the client's `eval` call; client construction and connection lifecycle
remain application responsibilities.

The default codec is stable-key JSON. Supply `encode(value): string` and
`decode(encoded): value` for another format. Encoding finishes before Redis is
called, so serialization failures cannot partially apply a transition.

Each logical key becomes one Redis hash:

```text
<prefix>{<base64url UTF-8 key>}:record
```

The hash tag is safe for Redis Cluster and leaves room for related keys in the
same slot. Keys and prefixes must contain well-formed Unicode; this prevents
UTF-8 encoders from collapsing lone UTF-16 surrogates into the replacement
character. Prefixes containing `{` or `}` are rejected.

Keys, operation IDs, reasons, Redis prefixes, and custom codec output reject
lone UTF-16 surrogates. Ordinary Unicode strings, including the actual U+FFFD
replacement character and valid surrogate pairs, retain the same key format.

`stateTtlSeconds` and `terminalTtlSeconds` are non-negative safe integers. Zero
means persistent. Expired or evicted records no longer reject delayed events.

Stored schema, kind, time, and presence flags are validated before a write.
Malformed hashes and wrong Redis types throw `CorruptStateError` without
repairing or replacing the record.

Redis numeric validation rejects NaN and positive or negative infinity in both
incoming script arguments and stored hashes before mutation. Corrupt terminal
watermarks therefore cannot be overwritten by exploiting non-finite Lua
comparisons.

Value and reason presence are stored separately, so an explicitly empty reason
round-trips as `reason: ""` rather than becoming absent.

## Coalesced snapshot reads

```js
import { createCoalescedSnapshotReader } from "event-watermark-store/cache";

const readSnapshot = createCoalescedSnapshotReader({
  read: () => loadSnapshot(),
  ttlMs: 1000,
});

await Promise.all([readSnapshot(), readSnapshot()]); // one underlying read
readSnapshot.invalidate();
```

Failures are not cached. Invalidation during an in-flight read prevents that
older result from repopulating the cache, and the next call starts a fresh read
without waiting for the older generation. `peek()` returns an unexpired cached
entry without refreshing it.

## Guarantees and limits

- Atomicity is per key and depends on the provider implementation. A batch
  across keys is not a transaction.
- Redis Lua execution is atomic, but Redis persistence, eviction, replication,
  and failover settings determine durability.
- Redis Cluster can lose an acknowledged write in documented failover windows.
- TTL defines how long an old event remains blocked; it is not archival
  retention.
- Event times are JavaScript numbers and Redis Lua numbers. Values outside
  exactly distinguishable numeric ranges can compare as the same number.
- Equal-time upserts intentionally refresh and replace the active value.
- Memory values without an `operationId` retain reference semantics. Values
  bound to an operation ID are snapshotted and cloned on read.
- Cached values are returned by reference and are not cloned.

For a bounded receiver migration profile, see
[service compatibility](docs/SERVICE_COMPATIBILITY.md). The provider model and
Redis schema are described in [design notes](docs/DESIGN.md).

## Verification

```sh
npm run check
```

The default suite tests the executor contract without requiring Redis. An
explicit local Redis can be checked when `redis-cli` is available:

```sh
npm run test:redis
```

This opt-in test uses a random prefix and deletes only its exact test key.

## License

[ISC](LICENSE)
