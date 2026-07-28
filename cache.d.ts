export interface CachedSnapshot<T> {
  readonly value: T;
  readonly expiresAt: number;
}

export interface CoalescedSnapshotReader<T> {
  (): Promise<T>;
  invalidate(): void;
  peek(): CachedSnapshot<T> | null;
}

export interface CoalescedSnapshotReaderOptions<T> {
  readonly read: () => Promise<T> | T;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export function createCoalescedSnapshotReader<T>(
  options: CoalescedSnapshotReaderOptions<T>,
): CoalescedSnapshotReader<T>;
