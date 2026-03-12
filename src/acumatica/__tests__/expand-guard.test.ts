import { describe, it, expect } from 'vitest';
import { guardListExpand, isGetExpandSafe } from '../expand-guard.js';

describe('expand-guard', () => {
  describe('guardListExpand()', () => {
    it('allows safe expands', () => {
      const result = guardListExpand('MainContact,Details');
      expect(result.safeExpand).toContain('MainContact');
      expect(result.safeExpand).toContain('Details');
    });

    it('strips dangerous expands from list queries', () => {
      const result = guardListExpand('MainContact,CreditVerificationRules,Attributes');
      expect(result.safeExpand).not.toContain('CreditVerificationRules');
      expect(result.safeExpand).not.toContain('Attributes');
      expect(result.stripped.length).toBeGreaterThan(0);
    });

    it('returns empty for undefined input', () => {
      const result = guardListExpand(undefined);
      expect(result.safeExpand).toBe('');
    });
  });

  describe('isGetExpandSafe()', () => {
    it('allows all expands on individual GET', () => {
      expect(isGetExpandSafe('CreditVerificationRules,Attributes')).toBe(true);
    });
  });
});
