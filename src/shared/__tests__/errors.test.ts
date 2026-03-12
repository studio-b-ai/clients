import { describe, it, expect } from 'vitest';
import { StudioBError, ApiError, AuthError, RateLimitError } from '../errors.js';

describe('errors', () => {
  it('StudioBError has code and statusCode', () => {
    const err = new StudioBError('test', 'TEST_CODE', 500);
    expect(err.code).toBe('TEST_CODE');
    expect(err.statusCode).toBe(500);
    expect(err.name).toBe('StudioBError');
    expect(err.message).toBe('test');
  });

  it('ApiError includes body', () => {
    const err = new ApiError('Not Found', 404, { error: 'missing' });
    expect(err.statusCode).toBe(404);
    expect(err.body).toEqual({ error: 'missing' });
    expect(err.name).toBe('ApiError');
  });

  it('AuthError defaults to 401', () => {
    const err = new AuthError('Unauthorized');
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('AUTH_ERROR');
  });

  it('RateLimitError includes retryAfter', () => {
    const err = new RateLimitError('Too many requests', 30);
    expect(err.statusCode).toBe(429);
    expect(err.retryAfter).toBe(30);
  });
});
