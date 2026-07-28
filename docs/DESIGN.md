# Design

## State model

A key has at most one record:

```text
absent
upsert(eventTime, receivedAt, optional value)
terminal(eventTime, receivedAt, optional reason)
```

The ordering decision uses only `kind` and `eventTime`. Arrival time, payload,
reason, and operation ID do not move a watermark.

The policy can be viewed as event-time ordering plus a terminal rank at equal
time. Equal upserts are refreshable. Equal terminals and equal upserts behind a
terminal are blocked.

## Atomic provider contract

`createEventWatermarkStore` validates a command, calls one provider
`transition`, and validates the returned status, flags, and watermarks. A
provider must perform its read, decision, and write as one per-key atomic
operation. Non-replay results are also checked against the same ordering policy;
a provider cannot report a stale result as applied or bypass an equal-time
terminal barrier. Replay results require an operation ID.

The core intentionally does not emulate atomicity with separate provider
`get`/`set` calls. The memory provider mutates synchronously. The Redis provider
uses one Lua invocation.

`operationId` is scoped to the current key record. A versioned SHA-256
fingerprint covers kind, event time, value presence and encoded content, and
reason presence and content. A matching ID and fingerprint is a replay; any
identity mismatch is a conflict. `receivedAt` is excluded because a retry may
receive a new server-clock value without changing the source operation. Once a
newer transition replaces the record, the provider does not retain historical
IDs.

The memory provider uses a canonical type-aware value encoding, including
sorted plain-object keys. Operation-bound values are cloned before storage and
on every read, keeping the stored payload aligned with its fingerprint. It
supports primitives, arrays, plain objects, dates, regular expressions, maps,
sets, array buffers, and typed binary views; cycles, functions, symbols, and
custom class instances are rejected.

The Redis default codec produces recursively stable-key JSON. A custom encoder
defines byte identity and is responsible for deterministic output.

## Redis record

The Redis provider stores one schema-version-2 hash per key with kind, event
time, received time, operation presence and fingerprint, value presence and
encoded value, and reason presence and content. Separate presence fields
preserve distinctions such as an absent reason versus an empty reason. One key
permits atomic execution in standalone and clustered Redis without a cross-slot
operation.

Logical keys are base64url-encoded from UTF-8 inside a Redis hash tag. Keys,
operation IDs, reasons, prefixes, and custom codec output must be well-formed
Unicode so a UTF-8 transport cannot replace a lone surrogate and merge distinct
JavaScript strings. Valid Unicode key encoding is unchanged.

The transition and read scripts return separate versioned protocols. Unknown
versions and outcomes are rejected by the JavaScript adapter.

The script checks type and required fields before any mutation. It does not
silently reinterpret or replace a malformed record. An accepted transition
replaces the complete hash so optional fields cannot leak from its predecessor.
Time and TTL parsing explicitly rejects Lua NaN and both infinities; JavaScript
post-validation is not relied upon to protect a corrupt terminal barrier.

## Retention

Active and terminal records may have different TTLs even though they share a
schema. A transition replaces the record and applies the TTL for its new kind.
Zero removes expiration.

TTL is measured by the provider clock, not `receivedAt`. The memory provider
clamps a backwards test clock. Redis uses its own key-expiration clock.

## Cache

The cache subpath is independent of the watermark store. It coalesces one
in-flight read, begins TTL after successful completion, does not cache errors,
and uses a generation counter so invalidation starts a new read while any older
generation finishes without overwriting current cache or in-flight state.
