/**
 * Acumatica shared recipes -- standalone functions that take a client instance.
 *
 * Reusable patterns extracted from webhook-router, provisioning-agent,
 * and other services. Import as `@studio-b-ai/clients/acumatica/recipes`.
 */

import type { AcumaticaClient } from './client.js';
import type { SessionGate } from './session-gate.js';

/**
 * Execute a function while holding a session gate lease.
 * Delegates to gate.withSession() for acquire/release lifecycle.
 */
export async function gatedQuery<T>(
  gate: Pick<SessionGate, 'withSession'>,
  fn: () => Promise<T>,
): Promise<T> {
  return gate.withSession(async () => fn());
}

/**
 * Fetch a full customer record with all sub-entities expanded.
 */
export async function getCustomerFull(
  client: Pick<AcumaticaClient, 'get'>,
  customerId: string,
): Promise<unknown> {
  return client.get(`Customer/${customerId}`, {
    $expand: 'MainContact,CreditVerificationRules,Salespersons,Attributes',
  });
}

/**
 * Fetch a full sales order with details, shipping, and financial settings.
 */
export async function getOrderFull(
  client: Pick<AcumaticaClient, 'get'>,
  orderNbr: string,
  orderType: string = 'SO',
): Promise<unknown> {
  return client.get(`SalesOrder/${orderType}/${orderNbr}`, {
    $expand: 'Details,ShippingSettings,FinancialSettings',
  });
}

/**
 * Fetch a full stock item with attributes and warehouse details.
 */
export async function getStockItemFull(
  client: Pick<AcumaticaClient, 'get'>,
  inventoryId: string,
): Promise<unknown> {
  return client.get(`StockItem/${inventoryId}`, {
    $expand: 'Attributes,WarehouseDetails',
  });
}

/**
 * Batch-fetch entities by field values, chunking into groups of 100
 * to avoid URI-too-long errors. Builds OR filters per chunk.
 */
export async function batchGetByFilter(
  client: Pick<AcumaticaClient, 'get'>,
  entity: string,
  field: string,
  values: string[],
  params?: Record<string, string | number>,
): Promise<unknown[]> {
  if (!values || values.length === 0) return [];

  const CHUNK = 100;
  const results: unknown[] = [];

  for (let i = 0; i < values.length; i += CHUNK) {
    const batch = values.slice(i, i + CHUNK);
    const filter = batch.map((v) => `${field} eq '${v}'`).join(' or ');
    const response = await client.get(entity, { ...params, $filter: filter });
    if (Array.isArray(response)) {
      results.push(...response);
    } else {
      results.push(response);
    }
  }

  return results;
}

/**
 * Set an attribute value on an entity record.
 * Uses pre-wrapped Attributes body (the client's put() auto-wraps top-level
 * fields, but Attributes array items need explicit value objects).
 */
export async function setEntityAttribute(
  client: Pick<AcumaticaClient, 'put'>,
  entity: string,
  key: string,
  attrId: string,
  value: string,
): Promise<unknown> {
  return client.put(`${entity}/${key}`, {
    Attributes: [{ AttributeID: { value: attrId }, Value: { value } }],
  });
}
