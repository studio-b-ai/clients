/**
 * Acumatica {value: x} wrapper/unwrapper utilities.
 *
 * Acumatica REST API wraps every scalar field: {"CustomerName": {"value": "MIAMI CORP"}}
 * These utilities make that transparent to callers.
 *
 * Extracted from acumatica-mcp/src/lib/value-wrapper.ts
 */

type AcumaticaValue = { value: unknown } | null | undefined;

/**
 * Unwrap a single Acumatica field value.
 * Handles: {value: x} -> x, null -> null, {} -> null, primitive -> primitive
 */
export function val(field: unknown): unknown {
  if (field === null || field === undefined) return null;
  if (typeof field === 'object' && !Array.isArray(field)) {
    const obj = field as Record<string, unknown>;
    // Empty object {} treated as null (common for missing FK refs)
    if (Object.keys(obj).length === 0) return null;
    // Standard {value: x} wrapper
    if ('value' in obj && Object.keys(obj).length === 1) return obj.value;
  }
  return field;
}

/**
 * Deep-unwrap an Acumatica response object.
 * Recursively strips {value: x} wrappers from all fields.
 */
export function unwrap(obj: unknown): unknown {
  if (obj === null || obj === undefined) return null;

  if (Array.isArray(obj)) {
    return obj.map(unwrap);
  }

  if (typeof obj === 'object') {
    const record = obj as Record<string, unknown>;

    // If it's a {value: x} wrapper, unwrap it
    if ('value' in record && Object.keys(record).length === 1) {
      return record.value;
    }

    // Empty object -> null
    if (Object.keys(record).length === 0) return null;

    // Recursively unwrap all properties
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      // Skip internal fields like 'id', 'rowNumber', 'note', 'custom', 'files'
      // that are NOT wrapped -- pass them through as-is
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value)
      ) {
        const vObj = value as Record<string, unknown>;
        if ('value' in vObj && Object.keys(vObj).length === 1) {
          // Standard {value: x} wrapper
          result[key] = vObj.value;
        } else if (Object.keys(vObj).length === 0) {
          result[key] = null;
        } else {
          // Nested object (sub-entity) -- recurse
          result[key] = unwrap(value);
        }
      } else if (Array.isArray(value)) {
        result[key] = value.map(unwrap);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  return obj;
}

/**
 * Deep-wrap plain values into Acumatica {value: x} format for create/update.
 * Only wraps scalar values -- arrays and nested objects are handled recursively.
 */
export function wrap(obj: unknown): unknown {
  if (obj === null || obj === undefined) return null;

  if (Array.isArray(obj)) {
    return obj.map(wrap);
  }

  if (typeof obj === 'object') {
    const record = obj as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (value === null || value === undefined) {
        result[key] = { value: null };
      } else if (Array.isArray(value)) {
        // Arrays (like Attributes) are wrapped element-by-element
        result[key] = value.map(wrap);
      } else if (typeof value === 'object') {
        // Already wrapped {value: x} or nested object -- check
        const vObj = value as Record<string, unknown>;
        if ('value' in vObj && Object.keys(vObj).length === 1) {
          // Already wrapped
          result[key] = value;
        } else {
          // Nested object -- recurse
          result[key] = wrap(value);
        }
      } else {
        // Scalar -- wrap it
        result[key] = { value };
      }
    }
    return result;
  }

  return { value: obj };
}

/**
 * Unwrap to string, with fallback.
 */
export function str(field: unknown, fallback = ''): string {
  const v = val(field);
  if (v === null || v === undefined) return fallback;
  return String(v);
}

/**
 * Convert Acumatica date field to epoch ms string (for HubSpot).
 */
export function toDateStr(field: unknown): string | null {
  const v = val(field);
  if (!v) return null;
  const d = new Date(v as string);
  return isNaN(d.getTime()) ? null : String(d.getTime());
}

/**
 * Convert to ISO string.
 */
export function toISOStr(field: unknown): string | null {
  const v = val(field);
  if (!v) return null;
  const d = new Date(v as string);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
