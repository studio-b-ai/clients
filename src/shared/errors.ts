/** Base error for all Studio B client operations */
export class StudioBError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'StudioBError';
  }
}

/** API returned an error response */
export class ApiError extends StudioBError {
  constructor(
    message: string,
    statusCode: number,
    public readonly body?: unknown,
  ) {
    super(message, 'API_ERROR', statusCode, { body });
    this.name = 'ApiError';
  }
}

/** Authentication failed */
export class AuthError extends StudioBError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'AUTH_ERROR', 401, details);
    this.name = 'AuthError';
  }
}

/** Rate limit exceeded */
export class RateLimitError extends StudioBError {
  constructor(
    message: string,
    public readonly retryAfter?: number,
  ) {
    super(message, 'RATE_LIMIT', 429, { retryAfter });
    this.name = 'RateLimitError';
  }
}
