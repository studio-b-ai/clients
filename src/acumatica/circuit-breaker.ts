/**
 * Circuit breaker for Acumatica API access.
 *
 * Trips open on account lockout or credential errors, halting all
 * outbound requests for a cooldown period. After cooldown, enters
 * half-open state to allow a single probe request through.
 *
 * States:
 *   closed   - normal operation, requests flow through
 *   open     - tripped, all requests rejected with 503
 *   half-open - cooldown expired, next request is a probe
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

/** Patterns that indicate the account is locked or credentials are bad */
const LOCKOUT_PATTERNS = [
  'account locked',
  'account is locked',
  'locked out',
  'login limit',
  'invalid credentials',
  'access denied',
  'your account has been',
];

export interface CircuitBreakerOptions {
  /** How long to keep the circuit open before allowing a probe (ms). Default: 600_000 (10 min) */
  cooldownMs?: number;
  /** Called when the circuit trips open */
  onTrip?: (reason: string) => void;
  /** Called when the circuit recovers to closed */
  onRecover?: () => void;
}

export class AcumaticaCircuitBreaker {
  private state: CircuitState = 'closed';
  private openedAt = 0;
  private tripReason = '';
  private cooldownMs: number;
  private onTripCb?: (reason: string) => void;
  private onRecoverCb?: () => void;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.cooldownMs = opts.cooldownMs ?? 600_000;
    this.onTripCb = opts.onTrip;
    this.onRecoverCb = opts.onRecover;
  }

  /**
   * Returns true if the circuit is open (requests should be blocked).
   * Also transitions from open -> half-open when cooldown expires.
   */
  get isOpen(): boolean {
    if (this.state === 'closed') return false;
    if (this.state === 'open' && Date.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'half-open';
      return false; // allow one probe through
    }
    return this.state === 'open';
  }

  get currentState(): CircuitState {
    // Trigger the open->half-open check
    this.isOpen;
    return this.state;
  }

  /** Seconds remaining until cooldown expires (0 if not open) */
  get retryAfterSeconds(): number {
    if (this.state !== 'open') return 0;
    const remaining = this.cooldownMs - (Date.now() - this.openedAt);
    return Math.max(0, Math.ceil(remaining / 1000));
  }

  /** The reason the circuit was tripped */
  get reason(): string {
    return this.tripReason;
  }

  /** Trip the circuit open. All requests will be blocked until cooldown. */
  trip(reason: string): void {
    if (this.state === 'open') return; // already tripped
    this.state = 'open';
    this.openedAt = Date.now();
    this.tripReason = reason;
    this.onTripCb?.(reason);
  }

  /** Recover the circuit to closed state. */
  recover(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.openedAt = 0;
    this.tripReason = '';
    this.onRecoverCb?.();
  }

  /** Called after a successful API request. Recovers from half-open. */
  onSuccess(): void {
    if (this.state === 'half-open') {
      this.recover();
    }
  }

  /** Called after a failed API request. Trips if the error indicates lockout. */
  onError(error: Error): void {
    if (isLockoutError(error)) {
      this.trip(error.message);
    }
  }
}

/**
 * Detect whether an error indicates an account lockout or credential failure.
 */
export function isLockoutError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return LOCKOUT_PATTERNS.some((pattern) => msg.includes(pattern));
}

/**
 * Error thrown when the circuit breaker is open and blocking requests.
 */
export class CircuitOpenError extends Error {
  readonly retryAfterSeconds: number;

  constructor(reason: string, retryAfterSeconds: number) {
    super(`Acumatica circuit breaker is open: ${reason}`);
    this.name = 'CircuitOpenError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
