# Service compatibility

This profile preserves a common event receiver contract:

```js
const provider = createRedisEventWatermarkProvider({
  execute,
  stateTtlSeconds: 300,
  terminalTtlSeconds: 7 * 24 * 60 * 60,
});
```

Map active observations to `upsert`, end/offline observations to `terminal`,
the source timestamp to `eventTime`, and receiver time to `receivedAt`.

Required compatibility points:

- an upsert equal to the latest upsert refreshes state;
- a terminal equal to an upsert replaces it;
- active events at or below a terminal remain blocked;
- an active event newer than a terminal resumes state;
- terminal state remains for seven days unless explicitly configured to
  persist;
- a receiver configured to require Redis must fail closed when Redis is
  unavailable; it must not silently switch to per-process memory.

The synthetic fixture at
[`fixtures/service-compatibility.json`](../fixtures/service-compatibility.json)
is executable documentation for this profile.

## Existing key migration

Changing a Redis prefix or key layout immediately hides old terminal
watermarks. Use an application-owned migration or a planned cutover after the
old terminal retention window.

Do not dual-write two layouts and describe the pair as atomic unless one Redis
script updates keys in a shared hash slot. During migration, reads should choose
the stricter applicable watermark.

Application-specific value fields and derived activity calculations belong in
the receiver integration. The package treats `value` as opaque data.

## Failure handling

A multi-key request can partially succeed because atomicity is per key. Keep
item-level results or stable operation IDs when the caller may retry a batch.
Retry the same operation ID only with the same kind, event time, value, and
reason; `receivedAt` may change. Use `changed`, rather than only `accepted`, to
decide whether a replay should trigger downstream work.
