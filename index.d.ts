export const POLICY_VERSION: 1;

export const TRANSITION_STATUSES: readonly [
  "applied",
  "refreshed",
  "replayed",
  "stale",
  "blocked-by-terminal",
];

export type TransitionKind = "upsert" | "terminal";
export type TransitionStatus = (typeof TRANSITION_STATUSES)[number];
export type DecisionStatus = Exclude<TransitionStatus, "replayed">;

export interface Watermark {
  readonly kind: TransitionKind;
  readonly eventTime: number;
}

export interface UpsertTransition<V> {
  readonly key: string;
  readonly kind: "upsert";
  readonly eventTime: number;
  readonly receivedAt?: number;
  readonly value?: V;
  readonly reason?: string;
  readonly operationId?: string;
}

export interface TerminalTransition {
  readonly key: string;
  readonly kind: "terminal";
  readonly eventTime: number;
  readonly receivedAt?: number;
  readonly value?: never;
  readonly reason?: string;
  readonly operationId?: string;
}

export type Transition<V> = UpsertTransition<V> | TerminalTransition;

export interface ProviderTransition<V> {
  readonly key: string;
  readonly kind: TransitionKind;
  readonly eventTime: number;
  readonly receivedAt: number;
  readonly valuePresent: boolean;
  readonly value: V | undefined;
  readonly reason: string | undefined;
  readonly operationId: string | undefined;
}

export interface TransitionResult {
  readonly status: TransitionStatus;
  readonly accepted: boolean;
  readonly changed: boolean;
  readonly previous: Watermark | null;
  readonly current: Watermark;
}

export interface UpsertRecord<V> {
  readonly key: string;
  readonly kind: "upsert";
  readonly eventTime: number;
  readonly receivedAt: number;
  readonly value?: V;
  readonly reason?: string;
  readonly operationId?: string;
}

export interface TerminalRecord {
  readonly key: string;
  readonly kind: "terminal";
  readonly eventTime: number;
  readonly receivedAt: number;
  readonly value?: never;
  readonly reason?: string;
  readonly operationId?: string;
}

export type StoredRecord<V> = UpsertRecord<V> | TerminalRecord;

export interface AtomicEventWatermarkProvider<V> {
  transition(command: ProviderTransition<V>): Promise<TransitionResult> | TransitionResult;
  get?(key: string): Promise<Omit<StoredRecord<V>, "key"> | null> | Omit<StoredRecord<V>, "key"> | null;
}

export interface EventWatermarkStore<V> {
  transition(input: Transition<V>): Promise<TransitionResult>;
  get(key: string): Promise<StoredRecord<V> | null>;
}

export interface DecisionInput {
  readonly current?: Watermark | null;
  readonly incoming: Watermark;
}

export interface EventWatermarkStoreOptions<V> {
  readonly provider: AtomicEventWatermarkProvider<V>;
  readonly clock?: () => number;
}

export class EventWatermarkError extends Error {}
export class ProviderContractError extends EventWatermarkError {}

export class CorruptStateError extends EventWatermarkError {
  readonly key: string;
  readonly detail: string;
  constructor(key: string, detail?: string);
}

export class OperationIdConflictError extends EventWatermarkError {
  readonly key: string;
  readonly operationId: string;
  constructor(key: string, operationId: string);
}

export function decideTransition(input: DecisionInput): DecisionStatus;

export function createEventWatermarkStore<V = unknown>(
  options: EventWatermarkStoreOptions<V>,
): EventWatermarkStore<V>;
