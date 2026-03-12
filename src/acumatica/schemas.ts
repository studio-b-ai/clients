/**
 * Acumatica MCP tool parameter schemas.
 * Extracted from acumatica-mcp/src/tools/*.ts
 *
 * 26 tools across 7 modules: CRUD, Enriched, Actions, Inquiry, Attachments, Utility, Webhooks
 */

import { z } from 'zod';

// ─── CRUD Tools (crud.ts) ──────────────────────────────────────────────────

/** acumatica_current_user — no parameters */
export const currentUserSchema = z.object({});
export type CurrentUserParams = z.infer<typeof currentUserSchema>;

/** acumatica_get_schema */
export const getSchemaSchema = z.object({
  entity: z
    .string()
    .describe('Entity name, e.g. "Customer", "SalesOrder", "StockItem"'),
});
export type GetSchemaParams = z.infer<typeof getSchemaSchema>;

/** acumatica_query */
export const querySchema = z.object({
  entity: z.string().describe('Entity name, e.g. "Customer", "SalesOrder"'),
  filter: z
    .string()
    .optional()
    .describe('OData filter, e.g. "Status eq \'Open\'"'),
  select: z
    .string()
    .optional()
    .describe('Comma-separated field names to return'),
  expand: z
    .string()
    .optional()
    .describe('Sub-entities to include, e.g. "MainContact,Details"'),
  orderby: z
    .string()
    .optional()
    .describe('Sort field, e.g. "LastModifiedDateTime desc"'),
  top: z
    .number()
    .optional()
    .default(100)
    .describe('Max records to return (default 100, max 500)'),
  skip: z.number().optional().describe('Pagination offset'),
});
export type QueryParams = z.infer<typeof querySchema>;

/** acumatica_get_record */
export const getRecordSchema = z.object({
  entity: z.string().describe('Entity name, e.g. "SalesOrder", "Customer"'),
  key: z
    .string()
    .describe(
      'Record key. For SalesOrder use "CO,S005321". For Customer use "C000004".',
    ),
  expand: z.string().optional().describe('Sub-entities to include'),
  select: z.string().optional().describe('Fields to return'),
});
export type GetRecordParams = z.infer<typeof getRecordSchema>;

/** acumatica_create_record */
export const createRecordSchema = z.object({
  entity: z.string().describe('Entity name'),
  fields: z
    .record(z.unknown())
    .describe(
      'Field values as key-value pairs, e.g. {"CustomerName": "ACME Corp"}',
    ),
});
export type CreateRecordParams = z.infer<typeof createRecordSchema>;

/** acumatica_update_record */
export const updateRecordSchema = z.object({
  entity: z.string().describe('Entity name'),
  key: z.string().describe('Record key value'),
  fields: z
    .record(z.unknown())
    .describe('Fields to update as key-value pairs'),
});
export type UpdateRecordParams = z.infer<typeof updateRecordSchema>;

/** acumatica_delete_record */
export const deleteRecordSchema = z.object({
  entity: z.string().describe('Entity name'),
  key: z.string().describe('Record key value'),
});
export type DeleteRecordParams = z.infer<typeof deleteRecordSchema>;

// ─── Enriched Entity Tools (enriched.ts) ────────────────────────────────────

/** acumatica_get_customer_full */
export const getCustomerFullSchema = z.object({
  customer_id: z.string().describe('Customer ID, e.g. "C000004"'),
});
export type GetCustomerFullParams = z.infer<typeof getCustomerFullSchema>;

/** acumatica_get_order_full */
export const getOrderFullSchema = z.object({
  order_type: z.string().describe('Order type, e.g. "CO", "SM"'),
  order_nbr: z.string().describe('Order number, e.g. "S005321"'),
});
export type GetOrderFullParams = z.infer<typeof getOrderFullSchema>;

/** acumatica_get_stock_item_full */
export const getStockItemFullSchema = z.object({
  inventory_id: z
    .string()
    .describe('Inventory ID, e.g. "00004" or "AFFINITY-CHAR"'),
});
export type GetStockItemFullParams = z.infer<typeof getStockItemFullSchema>;

/** acumatica_search_customers */
export const searchCustomersSchema = z.object({
  filter: z
    .string()
    .optional()
    .describe('OData filter for top-level fields'),
  modified_since: z
    .string()
    .optional()
    .describe('ISO datetime — shortcut for LastModifiedDateTime filter'),
  customer_class: z
    .string()
    .optional()
    .describe('Filter by CustomerClass, e.g. "RETAILER"'),
  status: z
    .string()
    .optional()
    .describe('Filter by Status, e.g. "Active"'),
  top: z
    .number()
    .optional()
    .default(100)
    .describe('Max records (default 100)'),
  expand_contacts: z
    .boolean()
    .optional()
    .default(false)
    .describe('Expand MainContact (safe on list queries)'),
  expand_salespersons: z
    .boolean()
    .optional()
    .default(false)
    .describe('Expand Salespersons (safe on list queries)'),
});
export type SearchCustomersParams = z.infer<typeof searchCustomersSchema>;

/** acumatica_search_orders */
export const searchOrdersSchema = z.object({
  filter: z.string().optional().describe('OData filter'),
  order_type: z
    .string()
    .optional()
    .describe('Filter by OrderType, e.g. "CO", "SM"'),
  status: z
    .string()
    .optional()
    .describe('Filter by Status, e.g. "Open", "Completed"'),
  customer_id: z.string().optional().describe('Filter by CustomerID'),
  modified_since: z
    .string()
    .optional()
    .describe('ISO datetime — shortcut for LastModifiedDateTime filter'),
  top: z
    .number()
    .optional()
    .default(100)
    .describe('Max records (default 100)'),
  include_details: z
    .boolean()
    .optional()
    .default(false)
    .describe('Expand line items (can be large)'),
});
export type SearchOrdersParams = z.infer<typeof searchOrdersSchema>;

// ─── Action Tools (actions.ts) ──────────────────────────────────────────────

/** acumatica_invoke_action */
export const invokeActionSchema = z.object({
  entity: z
    .string()
    .describe('Entity name, e.g. "SalesOrder", "Invoice", "Shipment"'),
  key: z.string().describe('Record key, e.g. "CO,S005321"'),
  action: z
    .string()
    .describe(
      'Action name, e.g. "ReleaseFromHold", "ConfirmShipment", "ReleaseInvoice"',
    ),
});
export type InvokeActionParams = z.infer<typeof invokeActionSchema>;

/** acumatica_get_action_status */
export const getActionStatusSchema = z.object({
  status_url: z
    .string()
    .describe('The status URL from a 202 response Location header'),
});
export type GetActionStatusParams = z.infer<typeof getActionStatusSchema>;

/** acumatica_list_actions */
export const listActionsSchema = z.object({
  entity: z
    .string()
    .describe('Entity name, e.g. "SalesOrder", "Invoice"'),
});
export type ListActionsParams = z.infer<typeof listActionsSchema>;

// ─── Inquiry Tools (inquiry.ts) ─────────────────────────────────────────────

/** acumatica_list_inquiries — no parameters */
export const listInquiriesSchema = z.object({});
export type ListInquiriesParams = z.infer<typeof listInquiriesSchema>;

/** acumatica_run_inquiry */
export const runInquirySchema = z.object({
  inquiry_name: z
    .string()
    .describe(
      'GI name or screen ID as configured in Acumatica, e.g. "CustomerAging", "InventoryAvailability"',
    ),
  parameters: z
    .record(z.string())
    .optional()
    .describe(
      'GI parameters as key-value pairs, e.g. {"CustomerClass": "RETAILER"}',
    ),
  filter: z.string().optional().describe('OData filter on GI results'),
  top: z
    .number()
    .optional()
    .default(200)
    .describe('Max rows (default 200)'),
  skip: z.number().optional().describe('Pagination offset'),
});
export type RunInquiryParams = z.infer<typeof runInquirySchema>;

// ─── Attachment Tools (attachments.ts) ──────────────────────────────────────

/** acumatica_list_attachments */
export const listAttachmentsSchema = z.object({
  entity: z
    .string()
    .describe('Entity name, e.g. "SalesOrder", "PurchaseOrder"'),
  key: z
    .string()
    .describe(
      'Record key, e.g. "CO,S005321" for SalesOrder, "PO000042" for PurchaseOrder',
    ),
});
export type ListAttachmentsParams = z.infer<typeof listAttachmentsSchema>;

/** acumatica_get_attachment */
export const getAttachmentSchema = z.object({
  entity: z.string().describe('Entity name, e.g. "SalesOrder"'),
  key: z.string().describe('Record key, e.g. "CO,S005321"'),
  filename: z
    .string()
    .describe(
      'Exact filename of the attachment to download (from list_attachments)',
    ),
});
export type GetAttachmentParams = z.infer<typeof getAttachmentSchema>;

/** acumatica_upload_attachment */
export const uploadAttachmentSchema = z.object({
  entity: z.string().describe('Entity name, e.g. "SalesOrder"'),
  key: z.string().describe('Record key, e.g. "CO,S005321"'),
  filename: z
    .string()
    .describe('Filename for the attachment, e.g. "invoice.pdf"'),
  content_base64: z.string().describe('Base64-encoded file content'),
  content_type: z
    .string()
    .optional()
    .default('application/octet-stream')
    .describe(
      'MIME type, e.g. "application/pdf", "image/png". Defaults to application/octet-stream',
    ),
});
export type UploadAttachmentParams = z.infer<typeof uploadAttachmentSchema>;

// ─── Utility Tools (utility.ts) ─────────────────────────────────────────────

/** acumatica_scan_instance — no parameters */
export const scanInstanceSchema = z.object({});
export type ScanInstanceParams = z.infer<typeof scanInstanceSchema>;

/** acumatica_get_relations */
export const getRelationsSchema = z.object({
  entity: z.string().describe('Entity name, e.g. "SalesOrder", "Case"'),
  key: z.string().describe('Record key value'),
});
export type GetRelationsParams = z.infer<typeof getRelationsSchema>;

/** acumatica_clear_cache */
export const clearCacheSchema = z.object({
  entity: z
    .string()
    .optional()
    .describe(
      'Entity name to clear, or omit to clear all cached schemas',
    ),
});
export type ClearCacheParams = z.infer<typeof clearCacheSchema>;

// ─── Webhook Tools (webhooks.ts) ────────────────────────────────────────────

/** acumatica_list_webhooks — no parameters */
export const listWebhooksSchema = z.object({});
export type ListWebhooksParams = z.infer<typeof listWebhooksSchema>;

/** acumatica_create_webhook */
export const createWebhookSchema = z.object({
  subscriber_name: z
    .string()
    .describe(
      'Unique name for this subscription, e.g. "studio-b-order-sync"',
    ),
  callback_url: z
    .string()
    .describe(
      'HTTPS URL to receive webhook POSTs, e.g. "https://webhook-router.up.railway.app/webhook/acumatica"',
    ),
  entity: z
    .string()
    .describe(
      'Entity to monitor, e.g. "SalesOrder", "Customer", "StockItem"',
    ),
  filter: z
    .string()
    .optional()
    .describe(
      'OData filter for selective notifications, e.g. "Status eq \'Open\'"',
    ),
});
export type CreateWebhookParams = z.infer<typeof createWebhookSchema>;

/** acumatica_delete_webhook */
export const deleteWebhookSchema = z.object({
  webhook_id: z
    .string()
    .describe(
      'The webhook/subscription ID to delete (from list_webhooks)',
    ),
});
export type DeleteWebhookParams = z.infer<typeof deleteWebhookSchema>;
