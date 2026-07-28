import type { AtomicEventWatermarkProvider, StoredRecord } from "event-watermark-store";

export const REDIS_SCHEMA_VERSION: "2";
export const REDIS_TRANSITION_PROTOCOL: "event-watermark-store:transition:2";
export const REDIS_READ_PROTOCOL: "event-watermark-store:read:2";
export const REDIS_TRANSITION_SCRIPT: string;
export const REDIS_READ_SCRIPT: string;

export interface RedisScriptRequest {
  readonly script: string;
  readonly keys: readonly string[];
  readonly arguments: readonly string[];
}

export type RedisScriptExecutor = (request: RedisScriptRequest) => Promise<unknown> | unknown;

export interface IoRedisLike {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown> | unknown;
}

export interface NodeRedisLike {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown> | unknown;
}

export interface ValueCodec<V> {
  encode(value: V): string;
  decode(value: string): V;
}

export interface RedisEventWatermarkProviderOptions<V> {
  readonly execute: RedisScriptExecutor;
  readonly prefix?: string;
  readonly stateTtlSeconds?: number;
  readonly terminalTtlSeconds?: number;
  readonly encode?: ValueCodec<V>["encode"];
  readonly decode?: ValueCodec<V>["decode"];
}

export interface RedisEventWatermarkProvider<V> extends AtomicEventWatermarkProvider<V> {
  get(key: string): Promise<Omit<StoredRecord<V>, "key"> | null>;
  keyFor(key: string): string;
}

export function createIoRedisExecutor(client: IoRedisLike): RedisScriptExecutor;
export function createNodeRedisExecutor(client: NodeRedisLike): RedisScriptExecutor;

export function createRedisEventWatermarkProvider<V = unknown>(
  options: RedisEventWatermarkProviderOptions<V>,
): RedisEventWatermarkProvider<V>;
