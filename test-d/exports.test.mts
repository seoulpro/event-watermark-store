import {
  CorruptStateError,
  createEventWatermarkStore,
  decideTransition,
  type AtomicEventWatermarkProvider,
  type ProviderTransition,
  type TransitionResult,
} from "event-watermark-store";
import { createCoalescedSnapshotReader } from "event-watermark-store/cache";
import { createMemoryEventWatermarkProvider } from "event-watermark-store/memory";
import {
  createIoRedisExecutor,
  createNodeRedisExecutor,
  createRedisEventWatermarkProvider,
  type RedisScriptExecutor,
} from "event-watermark-store/redis";

interface Payload {
  reading: number;
}

const memory = createMemoryEventWatermarkProvider<Payload>();
const store = createEventWatermarkStore({ provider: memory });
const transitionResult: Promise<TransitionResult> = store.transition({
  key: "typed",
  kind: "upsert",
  eventTime: 1,
  value: { reading: 2 },
});
const record = await store.get("typed");
if (record?.kind === "upsert" && record.value) {
  record.value.reading satisfies number;
}

// @ts-expect-error terminal transitions cannot carry a value
void store.transition({ key: "typed", kind: "terminal", eventTime: 2, value: { reading: 3 } });

decideTransition({
  current: { kind: "upsert", eventTime: 1 },
  incoming: { kind: "terminal", eventTime: 1 },
});

const provider: AtomicEventWatermarkProvider<Payload> = {
  transition(command: ProviderTransition<Payload>): TransitionResult {
    return {
      status: "applied",
      accepted: true,
      changed: true,
      previous: null,
      current: { kind: command.kind, eventTime: command.eventTime },
    };
  },
};
createEventWatermarkStore({ provider });

const execute: RedisScriptExecutor = async () => [];
createRedisEventWatermarkProvider<Payload>({ execute });
createIoRedisExecutor({ eval: async () => [] });
createNodeRedisExecutor({ eval: async () => [] });

const reader = createCoalescedSnapshotReader({ read: async () => [{ id: 1 }] });
const snapshots = await reader();
if (snapshots[0]) snapshots[0].id satisfies number;
reader.invalidate();
reader.peek();

new CorruptStateError("key").key satisfies string;
void transitionResult;
