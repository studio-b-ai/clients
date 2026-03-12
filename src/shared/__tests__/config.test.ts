import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AcumaticaConfigSchema, GitHubConfigSchema, RailwayConfigSchema } from '../config.js';

describe('config schemas', () => {
  describe('AcumaticaConfigSchema', () => {
    it('validates valid config', () => {
      const result = AcumaticaConfigSchema.parse({
        baseUrl: 'https://test.acumatica.com',
        username: 'api-bot',
        password: 'secret',
        tenant: 'Test',
        apiVersion: '24.200.001',
      });
      expect(result.baseUrl).toBe('https://test.acumatica.com');
      expect(result.apiVersion).toBe('24.200.001');
    });

    it('rejects invalid URL', () => {
      expect(() =>
        AcumaticaConfigSchema.parse({
          baseUrl: 'not-a-url',
          username: 'bot',
          password: 'pass',
        }),
      ).toThrow();
    });

    it('applies default apiVersion', () => {
      const result = AcumaticaConfigSchema.parse({
        baseUrl: 'https://test.acumatica.com',
        username: 'api-bot',
        password: 'secret',
      });
      expect(result.apiVersion).toBe('24.200.001');
    });
  });

  describe('GitHubConfigSchema', () => {
    it('applies default org', () => {
      const result = GitHubConfigSchema.parse({ token: 'ghp_test' });
      expect(result.org).toBe('studio-b-ai');
    });
  });

  describe('RailwayConfigSchema', () => {
    it('validates with token only', () => {
      const result = RailwayConfigSchema.parse({ token: 'test-token' });
      expect(result.token).toBe('test-token');
      expect(result.projectId).toBeUndefined();
    });
  });
});
