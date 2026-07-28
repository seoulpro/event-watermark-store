# Related specifications and implementations

This package uses documented Redis primitives and client extension points. The
following sources are useful when reviewing its guarantees:

- [Redis Lua scripting](https://redis.io/docs/latest/develop/programmability/eval-intro/)
  documents atomic script execution and script-cache behavior.
- [Redis Cluster specification](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)
  defines hash slots, hash tags, and failover limitations.
- [Redis key expiration](https://redis.io/docs/latest/develop/using-commands/keyspace/)
  defines TTL and persistence behavior.
- [ioredis](https://github.com/redis/ioredis) documents its positional `eval`
  and custom-command APIs. It is MIT licensed.
- [node-redis](https://github.com/redis/node-redis) documents its object-shaped
  `eval` API. It is MIT licensed.
- [ECMAScript Number](https://tc39.es/ecma262/multipage/numbers-and-dates.html)
  defines safe-integer and numeric comparison limits.

The package does not include source from these projects. Redis command names and
client call shapes are interoperability surfaces. The transition policy,
record schema, key encoding, response protocol, and tests are maintained here.
