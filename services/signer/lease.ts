// Local signer lifecycle only. This is not financial approval or device isolation.
export type WalletRole = "user" | "relayer" | "refund-approver";
export type LeaseOptions = {
  inactivityMs?: number;
  maxLeaseMs?: number;
  maxFailures?: number;
  failureWindowMs?: number;
  cooldownMs?: number;
  now?: () => number;
};
export class LeaseError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export class SignerLease<T> {
  #value: T | undefined;
  #generation = 0;
  #pending: number | undefined;
  #busy = false;
  #expires = 0;
  #hardExpiry = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #failures = 0;
  #window = 0;
  #blockedUntil = 0;
  #cleanupFailed = false;
  readonly now: () => number;
  readonly inactivityMs: number;
  readonly maxLeaseMs: number;
  readonly maxFailures: number;
  readonly failureWindowMs: number;
  readonly cooldownMs: number;
  constructor(
    readonly role: WalletRole,
    options: LeaseOptions = {},
    readonly dispose: (value: T) => void = () => {},
  ) {
    if (!["user", "relayer", "refund-approver"].includes(role))
      throw new LeaseError("INVALID_ROLE");
    this.now = options.now ?? (() => performance.now());
    this.inactivityMs = options.inactivityMs ?? 60000;
    this.maxLeaseMs = options.maxLeaseMs ?? 300000;
    this.maxFailures = options.maxFailures ?? 3;
    this.failureWindowMs = options.failureWindowMs ?? 60000;
    this.cooldownMs = options.cooldownMs ?? 30000;
    for (const [value, max] of [
      [this.inactivityMs, 300000],
      [this.maxLeaseMs, 900000],
      [this.maxFailures, 10],
      [this.failureWindowMs, 300000],
      [this.cooldownMs, 300000],
    ])
      if (!Number.isSafeInteger(value) || value < 1 || value > max)
        throw new LeaseError("INVALID_LEASE_OPTIONS");
    if (this.inactivityMs > this.maxLeaseMs)
      throw new LeaseError("INVALID_LEASE_OPTIONS");
  }
  lock() {
    this.#generation++;
    const previous = this.#value;
    this.#value = undefined;
    this.#expires = 0;
    this.#hardExpiry = 0;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (previous !== undefined) this.#discard(previous);
    // A cancelled KDF still occupies its slot until it settles. It cannot be
    // bypassed by lock/retry loops to create unbounded parallel decryption.
  }
  #discard(value: T) {
    try {
      this.dispose(value);
    } catch {
      this.#cleanupFailed = true;
    }
  }
  #expire() {
    if (this.#value !== undefined && this.now() >= this.#expires) this.lock();
  }
  status() {
    this.#expire();
    return Object.freeze({
      role: this.role,
      state:
        this.#value !== undefined
          ? "UNLOCKED"
          : this.#pending === this.#generation
            ? "UNLOCKING"
            : "LOCKED",
      expiresAt: this.#expires || null,
      cleanupFailed: this.#cleanupFailed,
    });
  }
  async unlock(load: () => Promise<T>, explicit: boolean) {
    if (explicit !== true) throw new LeaseError("APPROVAL_REQUIRED");
    if (this.#cleanupFailed) throw new LeaseError("SIGNER_CLEANUP_FAILED");
    if (this.#pending !== undefined || this.#busy)
      throw new LeaseError("SIGNER_BUSY");
    const now = this.now();
    if (now < this.#blockedUntil) throw new LeaseError("UNLOCK_THROTTLED");
    if (now >= this.#window + this.failureWindowMs) {
      this.#failures = 0;
      this.#window = now;
    }
    this.lock();
    if (this.#cleanupFailed) throw new LeaseError("SIGNER_CLEANUP_FAILED");
    const generation = this.#generation;
    this.#pending = generation;
    let value: T | undefined;
    try {
      value = await load();
      if (generation !== this.#generation)
        throw new LeaseError("UNLOCK_CANCELLED");
      this.#value = value;
      value = undefined;
      this.#hardExpiry = this.now() + this.maxLeaseMs;
      this.#expires = Math.min(
        this.now() + this.inactivityMs,
        this.#hardExpiry,
      );
      this.#failures = 0;
      this.#blockedUntil = 0;
      this.#schedule();
    } catch {
      if (value !== undefined) this.#discard(value);
      this.#failures = Math.min(this.maxFailures, this.#failures + 1);
      if (this.#failures >= this.maxFailures)
        this.#blockedUntil = this.now() + this.cooldownMs;
      if (generation !== this.#generation)
        throw new LeaseError("UNLOCK_CANCELLED");
      throw new LeaseError("UNLOCK_FAILED");
    } finally {
      this.#pending = undefined;
    }
  }
  #schedule() {
    clearTimeout(this.#timer);
    const generation = this.#generation,
      deadline = this.#expires;
    this.#timer = setTimeout(
      () => {
        if (generation !== this.#generation || deadline !== this.#expires)
          return;
        if (this.now() >= deadline) this.lock();
        else this.#schedule();
      },
      Math.max(1, this.#expires - this.now()),
    );
    this.#timer.unref();
  }
  capture(role: WalletRole) {
    this.#assert(role, this.#generation);
    return this.#generation;
  }
  #assert(role: WalletRole, generation: number) {
    this.#expire();
    if (role !== this.role) throw new LeaseError("SIGNER_ROLE_MISMATCH");
    if (this.#value === undefined || generation !== this.#generation)
      throw new LeaseError("WALLET_LOCKED");
  }
  async run<R>(
    role: WalletRole,
    generation: number,
    operation: (value: T) => Promise<R>,
  ): Promise<R> {
    this.#assert(role, generation);
    if (this.#busy) throw new LeaseError("SIGNER_BUSY");
    this.#busy = true;
    try {
      const result = await operation(this.#value!);
      this.#assert(role, generation); // A lock/expiry during crypto suppresses its result.
      this.#expires = Math.min(
        this.now() + this.inactivityMs,
        this.#hardExpiry,
      );
      this.#schedule();
      return result;
    } catch (e) {
      if (e instanceof LeaseError) throw e;
      throw new LeaseError("SIGNER_OPERATION_FAILED");
    } finally {
      this.#busy = false;
    }
  }
}
