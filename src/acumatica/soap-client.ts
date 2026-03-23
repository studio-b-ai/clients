/**
 * Acumatica SOAP Screen API client for operations that fail via REST.
 *
 * The REST API silently fails when writing lot/serial allocations to
 * existing SalesOrders. This client mimics UI interaction by driving
 * the SO301000 screen through the SOAP Screen API (GetSchema / Submit).
 *
 * Features:
 *   - Cookie-based session auth (same as REST — .ASPXAUTH)
 *   - Login / Logout per screen ID
 *   - GetSchema for field discovery
 *   - Submit with typed field commands
 *   - High-level allocateLot() for single-lot assignment
 *
 * SOAP endpoint pattern: {baseUrl}/Soap/{screenID}.asmx
 * SOAPAction pattern: "http://www.acumatica.com/typed/{operation}"
 */

import { request as undiciRequest } from 'undici';
import pino from 'pino';
import type { Logger } from 'pino';
import type { AcumaticaConfig } from '../shared/config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the SOAP client — same shape as REST client config. */
export interface SoapClientConfig {
  config: AcumaticaConfig;
  /** Request timeout in ms. Default: 30000 */
  requestTimeoutMs?: number;
  /** Logger instance */
  logger?: Logger;
}

/**
 * SOAP Screen API command types (from WSDL):
 *   - Value:  SET a field value (write)
 *   - Field:  READ a field value (return in response)
 *   - Action: Trigger screen action (Save, Delete, Cancel)
 *   - Key:    Navigate using key field
 */
export type SoapCommandType = 'Value' | 'Field' | 'Action' | 'Key';

/** A single SOAP Screen API command (field set or action trigger). */
export interface SoapCommand {
  /** Field name on the screen (e.g. "OrderType", "OrderNbr"). */
  fieldName: string;
  /** Object/view name on the screen (e.g. "Document", "Transactions"). */
  objectName: string;
  /** Value to set. Omit for actions like Save. */
  value?: string;
  /** When true, triggers server-side commit logic (like Tab in the UI). */
  commit?: boolean;
  /** Linked command reference name (rarely needed). */
  linkedCommand?: string;
  /** SOAP command type. Default: 'Value' for commands with value, 'Action' for Save/Delete/Cancel. */
  type?: SoapCommandType;
}

/** Parameters for the allocateLot high-level method. */
export interface AllocateLotParams {
  orderType: string;
  orderNbr: string;
  lineNbr: string;
  /** Lots to allocate. Currently only single-lot is supported. */
  lots: Array<{ lotSerialNbr: string; quantity?: number }>;
}

/** Result of an allocateLot operation. */
export interface AllocateLotResult {
  success: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// SOAP XML builders (template literals — simple enough, no lib needed)
// ---------------------------------------------------------------------------

function buildLoginXml(username: string, password: string, tenant?: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <Login xmlns="http://www.acumatica.com/typed/">
      <name>${escapeXml(username)}</name>
      <password>${escapeXml(password)}</password>
      ${tenant ? `<company>${escapeXml(tenant)}</company>` : ''}
    </Login>
  </soap:Body>
</soap:Envelope>`;
}

function buildLogoutXml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <Logout xmlns="http://www.acumatica.com/typed/" />
  </soap:Body>
</soap:Envelope>`;
}

function buildGetSchemaXml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetSchema xmlns="http://www.acumatica.com/typed/" />
  </soap:Body>
</soap:Envelope>`;
}

function buildSubmitXml(commands: SoapCommand[]): string {
  const commandsXml = commands
    .map((cmd) => {
      // Determine xsi:type from WSDL types:
      //   Value  = set a field value (write)
      //   Field  = read a field value
      //   Action = trigger screen action (Save, Delete, Cancel)
      //   Key    = navigate using key field
      const ACTION_FIELDS = new Set(['Save', 'Cancel', 'Delete', 'Insert', 'First', 'Last', 'Next', 'Prev']);
      const xsiType = cmd.type
        ?? (ACTION_FIELDS.has(cmd.fieldName) ? 'Action' : 'Value');

      const parts: string[] = [];
      parts.push(`      <Command xsi:type="${xsiType}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`);
      parts.push(`        <FieldName>${escapeXml(cmd.fieldName)}</FieldName>`);
      parts.push(`        <ObjectName>${escapeXml(cmd.objectName)}</ObjectName>`);
      if (cmd.value !== undefined) {
        parts.push(`        <Value>${escapeXml(cmd.value)}</Value>`);
      }
      if (cmd.commit) {
        parts.push(`        <Commit>true</Commit>`);
      }
      if (cmd.linkedCommand) {
        parts.push(`        <LinkedCommand>${escapeXml(cmd.linkedCommand)}</LinkedCommand>`);
      }
      parts.push(`      </Command>`);
      return parts.join('\n');
    })
    .join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <Submit xmlns="http://www.acumatica.com/typed/">
      <commands>
${commandsXml}
      </commands>
    </Submit>
  </soap:Body>
</soap:Envelope>`;
}

/** Escape special characters for XML text content. */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class SoapClient {
  private baseUrl: string;
  private username: string;
  private password: string;
  private tenant: string | undefined;
  private cookies = '';
  private timeoutMs: number;
  private log: Logger;

  constructor(opts: SoapClientConfig) {
    const { config } = opts;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.username = config.username;
    this.password = config.password;
    this.tenant = config.tenant;
    this.timeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.log = opts.logger ?? pino({ name: 'acumatica-soap' });
  }

  // -- Public API -----------------------------------------------------------

  /**
   * Login to a specific screen and store session cookies.
   * Must be called before submit() or getSchema().
   */
  async login(screenID: string): Promise<void> {
    const url = this.soapUrl(screenID);
    const body = buildLoginXml(this.username, this.password, this.tenant);

    this.log.debug({ screenID }, 'SOAP Login');
    const res = await this.soapRequest(url, 'Login', body);
    this.extractCookies(res.headers);

    if (!this.cookies) {
      this.checkFault(res.body, 'Login');
      throw new Error('SOAP Login failed — no session cookie returned');
    }

    this.log.info({ screenID }, 'SOAP Login OK');
  }

  /**
   * Logout from a screen and release the session slot.
   */
  async logout(screenID: string): Promise<void> {
    const url = this.soapUrl(screenID);
    const body = buildLogoutXml();

    this.log.debug({ screenID }, 'SOAP Logout');
    try {
      await this.soapRequest(url, 'Logout', body);
    } catch (err) {
      // Best-effort — log but don't throw
      this.log.warn({ screenID, err }, 'SOAP Logout error (ignored)');
    }
    this.cookies = '';
    this.log.info({ screenID }, 'SOAP Logout OK');
  }

  /**
   * Retrieve the field schema for a screen. Returns raw XML.
   * Useful for discovering object/field names (e.g. the lot split view).
   */
  async getSchema(screenID: string): Promise<string> {
    const url = this.soapUrl(screenID);
    const body = buildGetSchemaXml();

    this.log.debug({ screenID }, 'SOAP GetSchema');
    const res = await this.soapRequest(url, 'GetSchema', body);
    this.checkFault(res.body, 'GetSchema');
    return res.body;
  }

  /**
   * Submit field commands to a screen. Returns the raw XML response.
   */
  async submit(screenID: string, commands: SoapCommand[]): Promise<string> {
    const url = this.soapUrl(screenID);
    const body = buildSubmitXml(commands);

    this.log.debug({ screenID, commandCount: commands.length }, 'SOAP Submit');
    const res = await this.soapRequest(url, 'Submit', body);
    this.checkFault(res.body, 'Submit');
    return res.body;
  }

  /**
   * High-level: assign a lot/serial number to a SalesOrder line.
   *
   * Flow:
   *   1. Login to SO301000
   *   2. Load the order (OrderType + OrderNbr with commit)
   *   3. Select the line (LineNbr with commit)
   *   4. Set LotSerialNbr (with commit)
   *   5. Save (NO commit — action, not field value)
   *   6. Logout
   *
   *   IMPORTANT: Do NOT set Quantity alongside LotSerialNbr — causes
   *   Acumatica to re-evaluate splits and discard the lot assignment.
   *   Same pattern as REST API: "Do NOT include OrderQty in same PUT
   *   as Allocations."
   *
   * Currently supports single-lot only.
   * TODO: Multi-lot requires accessing the Allocations split view.
   *       Use getSchema('SO301000') to discover the split view/object name,
   *       then iterate with NewRow + LotSerialNbr + Quantity per lot.
   */
  async allocateLot(params: AllocateLotParams): Promise<AllocateLotResult> {
    const screenID = 'SO301000';
    const { orderType, orderNbr, lineNbr, lots } = params;

    if (lots.length === 0) {
      return { success: false, message: 'No lots provided' };
    }
    if (lots.length > 1) {
      return {
        success: false,
        message: 'Multi-lot allocation not yet supported — use single lot per call',
      };
    }

    const lot = lots[0]!;

    try {
      await this.login(screenID);

      const commands: SoapCommand[] = [
        // Navigate to the order — Key type for navigation (NOT Value, which creates new records)
        { fieldName: 'OrderType', objectName: 'Document', value: orderType, commit: true, type: 'Key' },
        { fieldName: 'OrderNbr', objectName: 'Document', value: orderNbr, commit: true, type: 'Key' },
        // Select the line — Key to navigate to specific line
        { fieldName: 'LineNbr', objectName: 'Transactions', value: lineNbr, commit: true, type: 'Key' },
        // Set lot serial number — Value type for writing. Do NOT set Quantity (causes lot discard)
        { fieldName: 'LotSerialNbr', objectName: 'Transactions', value: lot.lotSerialNbr, commit: true, type: 'Value' },
        // Save — Action type for screen actions
        { fieldName: 'Save', objectName: 'Document', type: 'Action' },
      ];

      const responseXml = await this.submit(screenID, commands);

      // Log response snippet for debugging persistence issues
      this.log.info(
        { orderType, orderNbr, lineNbr, lotSerialNbr: lot.lotSerialNbr, responseSnippet: responseXml.slice(0, 500) },
        'Lot allocated — SOAP Submit returned',
      );
      return { success: true, message: `Lot ${lot.lotSerialNbr} allocated to ${orderType} ${orderNbr} line ${lineNbr}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ orderType, orderNbr, lineNbr, err }, 'allocateLot failed');
      return { success: false, message };
    } finally {
      try {
        await this.logout(screenID);
      } catch {
        // Already logged inside logout()
      }
    }
  }

  // -- Private helpers ------------------------------------------------------

  /** Build the SOAP endpoint URL for a screen. */
  private soapUrl(screenID: string): string {
    return `${this.baseUrl}/Soap/${screenID}.asmx`;
  }

  /** Send a SOAP HTTP request with correct headers and session cookies. */
  private async soapRequest(
    url: string,
    operation: string,
    body: string,
  ): Promise<{ status: number; headers: Record<string, string | string[]>; body: string }> {
    const headers: Record<string, string> = {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: `"http://www.acumatica.com/typed/${operation}"`,
    };
    if (this.cookies) {
      headers['Cookie'] = this.cookies;
    }

    const res = await undiciRequest(url, {
      method: 'POST',
      headers,
      body,
      headersTimeout: this.timeoutMs,
      bodyTimeout: this.timeoutMs,
    });

    const text = await res.body.text();

    if (res.statusCode >= 400) {
      // Try to extract fault message from SOAP response
      const faultMatch = text.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/);
      const faultMsg = faultMatch?.[1]?.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&') ?? '';
      this.log.error({ url, operation, status: res.statusCode, fault: faultMsg || text.slice(0, 500) }, 'SOAP HTTP error');
      throw new Error(`SOAP ${operation} failed (HTTP ${res.statusCode}): ${faultMsg || text.slice(0, 300)}`);
    }

    return {
      status: res.statusCode,
      headers: res.headers as Record<string, string | string[]>,
      body: text,
    };
  }

  /** Extract session cookies from response headers. */
  private extractCookies(headers: Record<string, string | string[] | undefined>): void {
    const setCookieHeader = headers['set-cookie'];
    if (!setCookieHeader) return;

    const raw = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    const pairs = raw.map((c) => c.split(';')[0]!).filter(Boolean);
    if (pairs.length > 0) {
      this.cookies = pairs.join('; ');
    }
  }

  /** Check a SOAP response body for fault elements and throw if found. */
  private checkFault(responseBody: string, operation: string): void {
    if (responseBody.includes('<soap:Fault>') || responseBody.includes('<Fault>') || responseBody.includes('<faultstring>')) {
      // Extract fault message
      const faultMatch = responseBody.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/);
      const faultMsg = faultMatch?.[1] ?? 'Unknown SOAP fault';
      throw new Error(`SOAP ${operation} fault: ${faultMsg}`);
    }
  }
}

// ── Multi-Tenant Config ────────────────────────────────────────────────

export interface TenantConfig {
  baseUrl: string;
  username: string;
  password: string;
  company: string;
}

export type TenantName = 'production' | 'test' | 'sandbox';

export function loadTenantConfig(tenant: TenantName = 'production'): TenantConfig {
  const url = process.env.ACUMATICA_URL ?? '';
  const user = process.env.ACUMATICA_USERNAME ?? '';
  const pass = process.env.ACUMATICA_PASSWORD ?? '';

  const tenants: Record<TenantName, TenantConfig> = {
    production: {
      baseUrl: url,
      username: user,
      password: pass,
      company: process.env.ACUMATICA_TENANT ?? 'Heritage Fabrics',
    },
    test: {
      baseUrl: url,  // same instance
      username: user,
      password: pass,
      company: 'Heritage Test',
    },
    sandbox: {
      baseUrl: process.env.ACUMATICA_SANDBOX_URL ?? url,
      username: process.env.ACUMATICA_SANDBOX_USERNAME ?? user,
      password: process.env.ACUMATICA_SANDBOX_PASSWORD ?? pass,
      company: process.env.ACUMATICA_SANDBOX_TENANT ?? 'Heritage Fabrics',
    },
  };

  const config = tenants[tenant];
  if (!config?.baseUrl) {
    throw new Error(`No Acumatica config for tenant: ${tenant}`);
  }
  return config;
}

// ── Bolt Selection Logic ───────────────────────────────────────────────

export interface AvailableLot {
  lotSerialNbr: string;
  qty: number;
  receiptDate: string;
}

/**
 * Select bolts for a piece goods order using Heritage Fabrics business rules:
 *
 * 1. Single-bolt preference: find bolts >= orderQty AND <= 120% of orderQty
 * 2. Among qualifying bolts, pick the OLDEST (FIFO within range)
 * 3. Multi-bolt fallback: accumulate bolts FIFO, skip any that would exceed 120%
 */
export function selectBolts(
  available: AvailableLot[],
  orderQty: number,
  maxFillPercent = 1.2,
): AvailableLot[] {
  const maxQty = orderQty * maxFillPercent;

  // Sort all lots by receipt date (oldest first = FIFO)
  const sorted = [...available].sort(
    (a, b) => new Date(a.receiptDate).getTime() - new Date(b.receiptDate).getTime(),
  );

  // Phase 1: Single bolt — >= orderQty AND <= 120%, oldest first
  const singleBolt = sorted.find((l) => l.qty >= orderQty && l.qty <= maxQty);
  if (singleBolt) return [singleBolt];

  // Phase 2: Multi-bolt FIFO accumulation
  const selected: AvailableLot[] = [];
  let total = 0;

  for (const lot of sorted) {
    if (total >= orderQty) break;
    if (total + lot.qty > maxQty) continue; // skip if would exceed 120%
    selected.push(lot);
    total += lot.qty;
  }

  return selected;
}
