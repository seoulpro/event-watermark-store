import type { AtomicEventWatermarkProvider, StoredRecord } from "event-watermark-store";

export interface MemoryEventWatermarkProvider<V> extends AtomicEventWatermarkProvider<V> {
  get(key: string): Promise<Omit<StoredRecord<V>, "key"> | null>;
  clear(): void;
  size(): number;
}

export interface MemoryEventWatermarkProviderOptions {
  readonly stateTtlSeconds?: number;
  readonly terminalTtlSeconds?: number;
  readonly clock?: () => number;
}

export function createMemoryEventWatermarkProvider<V = unknown>(
  options?: MemoryEventWatermarkProviderOptions,
): MemoryEventWatermarkProvider<V>;
