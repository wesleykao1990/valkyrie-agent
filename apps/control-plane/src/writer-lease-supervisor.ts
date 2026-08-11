import type { ControlPlaneStore, WorkspaceLease } from "./store.ts";

export interface WriterLeaseSupervisorOptions {
  store: ControlPlaneStore;
  lease: WorkspaceLease;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  now?: () => Date;
  onLeaseLost: (reason: string) => Promise<void>;
}

/**
 * Host-owned lease heartbeat. The original fencing token is never replaced by a
 * fetched successor, so a stale supervisor cannot renew or release a rotated
 * lease. Its loss callback must stop a known, exactly owned handle before
 * quarantine; during slow startup it may quarantine first and clean the late
 * handle before that handle is ever allowed to execute.
 */
export class WriterLeaseSupervisor {
  private readonly options: WriterLeaseSupervisorOptions;
  private readonly leaseTtlMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly clock: () => Date;
  private lease: WorkspaceLease;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | null = null;
  private lostReason: string | null = null;
  private lossHandled = false;
  private lossOperation: Promise<void> | null = null;
  private fatalError: Error | null = null;

  constructor(options: WriterLeaseSupervisorOptions) {
    this.options = options;
    this.lease = options.lease;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
    this.clock = options.now ?? (() => new Date());
    if (this.lease.state !== "active") throw new Error("Writer lease supervisor requires an active lease");
    if (!Number.isSafeInteger(this.leaseTtlMs) || this.leaseTtlMs < 5_000 || this.leaseTtlMs > 5 * 60_000) {
      throw new Error("Supervised writer lease TTL must be between 5 seconds and 5 minutes");
    }
    if (!Number.isSafeInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs < 25 || this.heartbeatIntervalMs >= this.leaseTtlMs) {
      throw new Error("Writer heartbeat interval must be at least 25ms and shorter than its lease TTL");
    }
  }

  currentLease(): WorkspaceLease {
    return { ...this.lease };
  }

  start(): void {
    if (this.timer || this.lostReason) return;
    this.timer = setInterval(() => {
      void this.pulse().catch((error) => {
        this.fatalError = error instanceof Error ? error : new Error("Writer lease loss handling failed");
      });
    }, this.heartbeatIntervalMs);
    this.timer.unref();
  }

  async pulse(): Promise<void> {
    if (this.lostReason) return this.handleLoss();
    if (this.fatalError) throw this.fatalError;
    if (this.inFlight) return this.inFlight;
    const operation = this.renewOnce();
    this.inFlight = operation;
    try {
      await operation;
    } finally {
      if (this.inFlight === operation) this.inFlight = null;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    let failure: Error | null = null;
    if (this.inFlight) {
      try { await this.inFlight; }
      catch (error) { failure = error instanceof Error ? error : new Error("Writer lease heartbeat failed"); }
    }
    if (this.lostReason && !this.lossHandled) {
      try { await this.handleLoss(); }
      catch (error) { failure ??= error instanceof Error ? error : new Error("Writer lease loss handling failed"); }
    }
    if (failure ?? this.fatalError) throw (failure ?? this.fatalError)!;
  }

  assertHealthy(): void {
    if (this.fatalError) throw this.fatalError;
    if (this.lostReason) throw new Error(`Writer lease lost: ${this.lostReason}`);
  }

  private async renewOnce(): Promise<void> {
    try {
      const observedNow = this.clock().getTime();
      const previousHeartbeat = Date.parse(this.lease.heartbeatAt);
      const heartbeatMs = Math.max(observedNow, previousHeartbeat + 1);
      const heartbeatAt = new Date(heartbeatMs).toISOString();
      const expiresAt = new Date(Math.max(Date.parse(this.lease.expiresAt), heartbeatMs + this.leaseTtlMs)).toISOString();
      const renewed = await this.options.store.renewWorkspaceLease({
        workspaceId: this.lease.workspaceId,
        runId: this.lease.runId,
        ownerId: this.lease.ownerId,
        fencingToken: this.lease.fencingToken,
        heartbeatAt,
        expiresAt,
      });
      if (!renewed) {
        await this.markLost("fence_rejected_or_lease_expired");
        return;
      }
      this.lease = renewed;
    } catch {
      await this.markLost("heartbeat_storage_error");
    }
  }

  private async markLost(reason: string): Promise<void> {
    this.lostReason ??= reason;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.handleLoss();
  }

  private async handleLoss(): Promise<void> {
    if (!this.lostReason || this.lossHandled) return;
    if (this.lossOperation) return this.lossOperation;
    const operation = (async () => {
      try {
        await this.options.onLeaseLost(this.lostReason!);
        this.lossHandled = true;
        this.fatalError = null;
      } catch (error) {
        this.fatalError = error instanceof Error ? error : new Error("Writer lease loss handling failed");
        throw this.fatalError;
      }
    })();
    this.lossOperation = operation;
    try {
      await operation;
    } finally {
      if (this.lossOperation === operation) this.lossOperation = null;
    }
  }
}
