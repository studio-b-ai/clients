import { describe, it, expect } from 'vitest';
import { val, unwrap, wrap, str, toDateStr, toISOStr } from '../value-wrapper.js';

describe('value-wrapper', () => {
  describe('val()', () => {
    it('extracts value from {value: x} wrapper', () => {
      expect(val({ value: 'hello' })).toBe('hello');
    });

    it('returns raw value when not wrapped', () => {
      expect(val('hello')).toBe('hello');
    });

    it('returns null for null/undefined', () => {
      expect(val(null)).toBeNull();
      expect(val(undefined)).toBeNull();
    });

    it('handles nested numeric values', () => {
      expect(val({ value: 42 })).toBe(42);
    });

    it('handles boolean values', () => {
      expect(val({ value: false })).toBe(false);
    });
  });

  describe('unwrap()', () => {
    it('unwraps a flat object', () => {
      const input = {
        CustomerID: { value: 'C000001' },
        CustomerName: { value: 'Test Corp' },
        Status: { value: 'Active' },
      };
      const result = unwrap(input);
      expect(result).toEqual({
        CustomerID: 'C000001',
        CustomerName: 'Test Corp',
        Status: 'Active',
      });
    });

    it('passes through already-unwrapped values', () => {
      expect(unwrap({ name: 'test' })).toEqual({ name: 'test' });
    });

    it('handles arrays', () => {
      const input = [
        { ID: { value: '1' } },
        { ID: { value: '2' } },
      ];
      const result = unwrap(input);
      expect(result).toEqual([
        { ID: '1' },
        { ID: '2' },
      ]);
    });

    it('handles null', () => {
      expect(unwrap(null)).toBeNull();
    });
  });

  describe('wrap()', () => {
    it('wraps flat values', () => {
      const result = wrap({ CustomerID: 'C000001', Status: 'Active' });
      expect(result).toEqual({
        CustomerID: { value: 'C000001' },
        Status: { value: 'Active' },
      });
    });

    it('wraps null values as {value: null}', () => {
      const result = wrap({ name: 'test', empty: null }) as Record<string, unknown>;
      expect(result).toEqual({
        name: { value: 'test' },
        empty: { value: null },
      });
    });

    it('handles nested objects (sub-entities)', () => {
      const result = wrap({
        MainContact: { Email: 'test@test.com' },
      });
      expect(result.MainContact).toBeDefined();
    });
  });

  describe('str()', () => {
    it('extracts string from wrapped value', () => {
      expect(str({ value: 'hello' })).toBe('hello');
    });

    it('returns empty string for null', () => {
      expect(str(null)).toBe('');
    });
  });
});
