import { createEventWatermarkStore } from "event-watermark-store";
import { createMemoryEventWatermarkProvider } from "event-watermark-store/memory";

const provider = createMemoryEventWatermarkProvider({
  stateTtlSeconds: 300,
  terminalTtlSeconds: 7 * 24 * 60 * 60,
});
const store = createEventWatermarkStore({ provider });

await store.transition({
  key: "sensor-a",
  kind: "upsert",
  eventTime: 100,
  value: { reading: 42 },
});
await store.transition({
  key: "sensor-a",
  kind: "terminal",
  eventTime: 100,
  reason: "completed",
});

console.log(await store.get("sensor-a"));
