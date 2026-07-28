# Changelog

## 0.1.0

- Define terminal-preferred event-time ordering.
- Add atomic provider and in-memory implementations.
- Add a single-key, cluster-safe Redis Lua provider.
- Add ioredis and node-redis executor helpers without runtime dependencies.
- Add content-bound operation replay classification and corrupt-state
  rejection.
- Preserve absent versus empty reasons in the Redis schema.
- Bind replay identity to immutable memory snapshots and stable-key JSON.
- Reject malformed Unicode before UTF-8 transport can collapse identifiers.
- Validate provider outcomes against the public ordering policy.
- Reject non-finite Redis Lua numbers before any state mutation.
- Add coalesced snapshot reads with invalidation.
- Start a fresh cache read immediately after in-flight invalidation.
