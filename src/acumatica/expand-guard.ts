/**
 * Sub-entity safety guard for Acumatica $expand.
 *
 * Knows which sub-entities are safe on list queries vs. individual GETs.
 * Auto-strips dangerous expands from list queries and returns warnings.
 *
 * Extracted from acumatica-mcp/src/lib/expand-guard.ts
 */

interface ExpandInfo {
  safeOnList: boolean;
  safeOnGet: boolean;
  note: string;
}

const EXPAND_TABLE: Record<string, ExpandInfo> = {
  MainContact: { safeOnList: true, safeOnGet: true, note: 'Safe everywhere' },
  BillingContact: {
    safeOnList: true,
    safeOnGet: true,
    note: 'Safe everywhere',
  },
  ShippingContact: {
    safeOnList: true,
    safeOnGet: true,
    note: 'Safe everywhere',
  },
  CreditVerificationRules: {
    safeOnList: false,
    safeOnGet: true,
    note: 'BQL delegate breaks list optimization -- causes 500 on list queries',
  },
  Salespersons: {
    safeOnList: true,
    safeOnGet: true,
    note: 'Safe everywhere',
  },
  PrimaryContact: {
    safeOnList: true,
    safeOnGet: true,
    note: 'Safe everywhere',
  },
  Attributes: {
    safeOnList: false,
    safeOnGet: true,
    note: 'Returns empty array on list queries -- only populated on individual GET',
  },
  Details: {
    safeOnList: true,
    safeOnGet: true,
    note: 'Safe but can be large on orders with many line items',
  },
  Shipments: {
    safeOnList: true,
    safeOnGet: true,
    note: 'Safe everywhere',
  },
  Packages: {
    safeOnList: true,
    safeOnGet: true,
    note: 'Contains tracking numbers',
  },
  WarehouseDetails: {
    safeOnList: true,
    safeOnGet: true,
    note: 'Stock item availability',
  },
  CrossReferences: {
    safeOnList: true,
    safeOnGet: true,
    note: 'Safe everywhere',
  },
  FinancialSettings: {
    safeOnList: true,
    safeOnGet: true,
    note: 'Safe everywhere',
  },
  Payments: { safeOnList: true, safeOnGet: true, note: 'Safe everywhere' },
  Totals: { safeOnList: true, safeOnGet: true, note: 'Safe everywhere' },
  ShipToContact: {
    safeOnList: true,
    safeOnGet: true,
    note: 'Safe everywhere',
  },
  ShipToAddress: {
    safeOnList: true,
    safeOnGet: true,
    note: 'Safe everywhere',
  },
  BillToContact: {
    safeOnList: true,
    safeOnGet: true,
    note: 'Safe everywhere',
  },
  BillToAddress: {
    safeOnList: true,
    safeOnGet: true,
    note: 'Safe everywhere',
  },
};

export interface ExpandGuardResult {
  safeExpand: string;
  warnings: string[];
  stripped: string[];
}

/**
 * Guard $expand values for list queries.
 * Strips dangerous sub-entities and returns warnings.
 */
export function guardListExpand(expand: string): ExpandGuardResult {
  if (!expand) return { safeExpand: '', warnings: [], stripped: [] };

  const parts = expand.split(',').map((s) => s.trim());
  const safe: string[] = [];
  const warnings: string[] = [];
  const stripped: string[] = [];

  for (const part of parts) {
    const info = EXPAND_TABLE[part];
    if (!info) {
      // Unknown sub-entity -- allow but warn
      safe.push(part);
      warnings.push(
        `Unknown sub-entity "${part}" -- allowing but it may cause errors`,
      );
    } else if (info.safeOnList) {
      safe.push(part);
    } else {
      stripped.push(part);
      warnings.push(
        `Stripped "${part}" from list query: ${info.note}. Use individual record fetch for this sub-entity.`,
      );
    }
  }

  return {
    safeExpand: safe.join(','),
    warnings,
    stripped,
  };
}

/**
 * Check if an expand is safe on an individual GET.
 */
export function isGetExpandSafe(expand: string): boolean {
  if (!expand) return true;
  const parts = expand.split(',').map((s) => s.trim());
  return parts.every((part) => {
    const info = EXPAND_TABLE[part];
    return !info || info.safeOnGet;
  });
}
