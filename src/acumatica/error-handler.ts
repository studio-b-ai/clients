/**
 * Known Acumatica API error patterns -> structured error responses.
 *
 * Maps raw HTTP errors to friendly codes with suggestions for the caller.
 *
 * Extracted from acumatica-mcp/src/lib/error-handler.ts
 */

export interface AcumaticaError {
  error: true;
  code: string;
  message: string;
  suggestion?: string;
  rawStatus?: number;
  rawMessage?: string;
}

interface ErrorPattern {
  match: (status: number, body: string, url: string) => boolean;
  code: string;
  message: string;
  suggestion?: string;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  {
    match: (status, body) =>
      status === 500 && body.includes('CreditVerificationRules'),
    code: 'CREDIT_RULES_LIST_EXPAND',
    message:
      'CreditVerificationRules cannot be expanded on list queries (Acumatica BQL limitation). Use individual record fetch instead.',
    suggestion: 'get_customer_full',
  },
  {
    match: (status, _body, url) =>
      status === 500 && url.includes('$select=custom'),
    code: 'CUSTOM_SELECT_NOT_SUPPORTED',
    message:
      '$select=custom causes 500 errors on Acumatica. Use schema endpoint to discover custom fields instead.',
    suggestion: 'get_schema',
  },
  {
    match: (status) => status === 404,
    code: 'ENTITY_NOT_FOUND',
    message:
      'Entity or record not found. Check the entity name (e.g., use "StockItem" not "InventoryItem") and key format (e.g., "CO,S005321" for SalesOrder).',
  },
  {
    match: (status) => status === 401,
    code: 'SESSION_EXPIRED',
    message: 'Acumatica session expired. Will auto-retry with fresh login.',
  },
  {
    match: (status, body) =>
      status === 500 && body.includes('API Login Limit'),
    code: 'SESSION_LIMIT',
    message:
      'Acumatica concurrent session limit reached. Waiting for session gate slot.',
  },
  {
    match: (status, body) =>
      status === 500 && body.includes('KeyNotFoundException'),
    code: 'CUSTOM_ATTR_FILTER',
    message:
      'Custom attributes cannot be used in OData $filter. Filter on standard fields and post-filter results in your code.',
  },
  {
    match: (status) => status === 414,
    code: 'URI_TOO_LONG',
    message:
      'Request URI too long. Reduce the number of IDs or filter values (max ~100 per request).',
  },
];

/**
 * Match an HTTP error to a known Acumatica pattern.
 * Returns structured error if matched, null otherwise.
 */
export function matchError(
  status: number,
  body: string,
  url: string,
): AcumaticaError | null {
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.match(status, body, url)) {
      return {
        error: true,
        code: pattern.code,
        message: pattern.message,
        suggestion: pattern.suggestion,
        rawStatus: status,
        rawMessage: body.slice(0, 500),
      };
    }
  }
  return null;
}

/**
 * Create a structured error for any unmatched HTTP error.
 */
export function genericError(
  status: number,
  body: string,
  url: string,
): AcumaticaError {
  return {
    error: true,
    code: 'ACUMATICA_API_ERROR',
    message: `Acumatica API returned HTTP ${status} for ${url}`,
    rawStatus: status,
    rawMessage: body.slice(0, 500),
  };
}

/**
 * Create a cloud-not-supported error for customization tools.
 */
export function cloudNotSupportedError(tool: string): AcumaticaError {
  return {
    error: true,
    code: 'CLOUD_CUSTOMIZATION_NOT_SUPPORTED',
    message: `${tool} is not available on cloud-hosted Acumatica instances. Use Acumatica UI (SM204505) for customization project management.`,
  };
}
