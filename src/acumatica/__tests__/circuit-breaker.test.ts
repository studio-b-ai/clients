import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AcumaticaCircuitBreaker, isLockoutError, CircuitOpenError } from '../circuit-breaker.js';
import { AccountLockedError } from '../error-handler.js';

describe('AcumaticaCircuitBreaker', () => {
  let breaker: AcumaticaCircuitBreaker;

  beforeEach(() => {
    breaker = new AcumaticaCircuitBreaker({ cooldownMs: 1000 });
  });

  it('starts in closed state', () => {
    expect(breaker.currentState).toBe('closed');
    expect(breaker.isOpen).toBe(false);
  });

  it('trips open on lockout error', () => {
    breaker.onError(new AccountLockedError());
    expect(breaker.currentState).toBe('open');
    expect(breaker.isOpen).toBe(true);
  });

  it('does not trip on non-lockout errors', () => {
    breaker.onError(new Error('network timeout'));
    expect(breaker.currentState).toBe('closed');
  });

  it('blocks requests while open', () => {
    breaker.trip('test lockout');
    expect(breaker.isOpen).toBe(true);
    expect(breaker.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('transitions to half-open after cooldown', async () => {
    breaker = new AcumaticaCircuitBreaker({ cooldownMs: 50 });
    breaker.trip('test');
    expect(breaker.isOpen).toBe(true);

    await new Promise((r) => setTimeout(r, 60));
    expect(breaker.isOpen).toBe(false);
    expect(breaker.currentState).toBe('half-open');
  });

  it('recovers from half-open on success', async () => {
    breaker = new AcumaticaCircuitBreaker({ cooldownMs: 50 });
    breaker.trip('test');
    await new Promise((r) => setTimeout(r, 60));

    // Access isOpen to trigger open -> half-open transition
    expect(breaker.isOpen).toBe(false);
    expect(breaker.currentState).toBe('half-open');

    breaker.onSuccess();
    expect(breaker.currentState).toBe('closed');
  });

  it('calls onTrip and onRecover callbacks', () => {
    const onTrip = vi.fn();
    const onRecover = vi.fn();
    breaker = new AcumaticaCircuitBreaker({ cooldownMs: 1000, onTrip, onRecover });

    breaker.trip('lockout detected');
    expect(onTrip).toHaveBeenCalledWith('lockout detected');

    breaker.recover();
    expect(onRecover).toHaveBeenCalled();
  });

  it('does not double-trip', () => {
    const onTrip = vi.fn();
    breaker = new AcumaticaCircuitBreaker({ cooldownMs: 1000, onTrip });

    breaker.trip('first');
    breaker.trip('second');
    expect(onTrip).toHaveBeenCalledTimes(1);
  });
});

describe('isLockoutError()', () => {
  it('detects "locked out" in message', () => {
    expect(isLockoutError(new Error('Account locked out by admin'))).toBe(true);
  });

  it('detects "account is locked" in message', () => {
    expect(isLockoutError(new Error('The account is locked'))).toBe(true);
  });

  it('detects AccountLockedError by name', () => {
    expect(isLockoutError(new AccountLockedError())).toBe(true);
  });

  it('does not false-positive on unrelated errors', () => {
    expect(isLockoutError(new Error('Network timeout'))).toBe(false);
    expect(isLockoutError(new Error('Entity not found'))).toBe(false);
  });

  it('detects "login limit" pattern', () => {
    expect(isLockoutError(new Error('API Login Limit reached'))).toBe(true);
  });
});

describe('CircuitOpenError', () => {
  it('includes retry after seconds', () => {
    const err = new CircuitOpenError('lockout', 300);
    expect(err.retryAfterSeconds).toBe(300);
    expect(err.name).toBe('CircuitOpenError');
    expect(err.message).toContain('lockout');
  });
});
