import core = require("event-watermark-store");
import cache = require("event-watermark-store/cache");
import memory = require("event-watermark-store/memory");
import redis = require("event-watermark-store/redis");

const provider = memory.createMemoryEventWatermarkProvider<string>();
const store = core.createEventWatermarkStore({ provider });
void store.transition({ key: "commonjs", kind: "upsert", eventTime: 1, value: "ok" });

const reader = cache.createCoalescedSnapshotReader({ read: () => "snapshot" });
void reader();

const execute: redis.RedisScriptExecutor = () => [
  redis.REDIS_TRANSITION_PROTOCOL,
  "applied",
  "",
  "",
  "upsert",
  "1",
];
redis.createRedisEventWatermarkProvider({ execute });
