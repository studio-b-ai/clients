import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SoapClient } from '../soap-client.js';
import type { SoapCommand, AllocateLotParams } from '../soap-client.js';
import type { AcumaticaConfig } from '../../shared/config.js';

// ---------------------------------------------------------------------------
// Mock undici
// ---------------------------------------------------------------------------

const mockRequest = vi.fn();
vi.mock('undici', () => ({
  request: (...args: unknown[]) => mockRequest(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_CONFIG: AcumaticaConfig = {
  baseUrl: 'https://test.acumatica.com',
  username: 'admin',
  password: 'secret',
  tenant: 'TestCo',
  apiVersion: '24.200.001',
};

/** Build a mock undici response. */
function mockResponse(
  statusCode: number,
  body: string,
  headers: Record<string, string | string[]> = {},
) {
  return {
    statusCode,
    headers,
    body: { text: async () => body },
  };
}

const LOGIN_SUCCESS_BODY = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <LoginResponse xmlns="http://www.acumatica.com/typed/" />
  </soap:Body>
</soap:Envelope>`;

const SUBMIT_SUCCESS_BODY = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <SubmitResponse xmlns="http://www.acumatica.com/typed/">
      <SubmitResult />
    </SubmitResponse>
  </soap:Body>
</soap:Envelope>`;

const SOAP_FAULT_BODY = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <soap:Fault>
      <faultcode>soap:Server</faultcode>
      <faultstring>Record not found</faultstring>
    </soap:Fault>
  </soap:Body>
</soap:Envelope>`;

const LOGOUT_SUCCESS_BODY = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <LogoutResponse xmlns="http://www.acumatica.com/typed/" />
  </soap:Body>
</soap:Envelope>`;

const SCHEMA_SUCCESS_BODY = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetSchemaResponse xmlns="http://www.acumatica.com/typed/">
      <GetSchemaResult><Screen><ObjectName>Document</ObjectName></Screen></GetSchemaResult>
    </GetSchemaResponse>
  </soap:Body>
</soap:Envelope>`;

// Suppress pino output during tests
const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn().mockReturnThis(),
  level: 'silent',
} as any;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SoapClient', () => {
  let client: SoapClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new SoapClient({ config: TEST_CONFIG, logger: silentLogger });
  });

  // -- login() ------------------------------------------------------------

  describe('login()', () => {
    it('sends Login SOAPAction and stores cookies', async () => {
      mockRequest.mockResolvedValueOnce(
        mockResponse(200, LOGIN_SUCCESS_BODY, {
          'set-cookie': ['.ASPXAUTH=abc123; path=/; HttpOnly'],
        }),
      );

      await client.login('SO301000');

      expect(mockRequest).toHaveBeenCalledTimes(1);
      const [url, opts] = mockRequest.mock.calls[0]!;
      expect(url).toBe('https://test.acumatica.com/Soap/SO301000.asmx');
      expect(opts.headers.SOAPAction).toBe('"http://www.acumatica.com/typed/Login"');
      expect(opts.headers['Content-Type']).toBe('text/xml; charset=utf-8');
      expect(opts.method).toBe('POST');
      // Body should contain credentials
      expect(opts.body).toContain('<name>admin</name>');
      expect(opts.body).toContain('<password>secret</password>');
      expect(opts.body).toContain('<company>TestCo</company>');
    });

    it('throws when no cookie is returned', async () => {
      mockRequest.mockResolvedValueOnce(
        mockResponse(200, LOGIN_SUCCESS_BODY, {}),
      );

      await expect(client.login('SO301000')).rejects.toThrow(
        'SOAP Login failed — no session cookie returned',
      );
    });

    it('throws on HTTP error', async () => {
      mockRequest.mockResolvedValueOnce(
        mockResponse(401, 'Unauthorized', {}),
      );

      await expect(client.login('SO301000')).rejects.toThrow('SOAP Login failed (HTTP 401)');
    });
  });

  // -- submit() -----------------------------------------------------------

  describe('submit()', () => {
    it('sends Submit SOAPAction with correct XML commands', async () => {
      // Login first to set cookies
      mockRequest.mockResolvedValueOnce(
        mockResponse(200, LOGIN_SUCCESS_BODY, {
          'set-cookie': '.ASPXAUTH=abc123; path=/',
        }),
      );
      await client.login('SO301000');
      vi.clearAllMocks();

      // Now submit
      mockRequest.mockResolvedValueOnce(
        mockResponse(200, SUBMIT_SUCCESS_BODY),
      );

      const commands: SoapCommand[] = [
        { fieldName: 'OrderType', objectName: 'Document', value: 'SO', commit: true },
        { fieldName: 'OrderNbr', objectName: 'Document', value: '000123' },
      ];

      await client.submit('SO301000', commands);

      expect(mockRequest).toHaveBeenCalledTimes(1);
      const [url, opts] = mockRequest.mock.calls[0]!;
      expect(url).toBe('https://test.acumatica.com/Soap/SO301000.asmx');
      expect(opts.headers.SOAPAction).toBe('"http://www.acumatica.com/typed/Submit"');
      expect(opts.headers['Cookie']).toBe('.ASPXAUTH=abc123');
      // Check command XML
      expect(opts.body).toContain('<FieldName>OrderType</FieldName>');
      expect(opts.body).toContain('<ObjectName>Document</ObjectName>');
      expect(opts.body).toContain('<Value>SO</Value>');
      expect(opts.body).toContain('<Commit>true</Commit>');
      expect(opts.body).toContain('<FieldName>OrderNbr</FieldName>');
      expect(opts.body).toContain('<Value>000123</Value>');
    });

    it('throws on SOAP fault', async () => {
      // Login
      mockRequest.mockResolvedValueOnce(
        mockResponse(200, LOGIN_SUCCESS_BODY, {
          'set-cookie': '.ASPXAUTH=abc123; path=/',
        }),
      );
      await client.login('SO301000');
      vi.clearAllMocks();

      mockRequest.mockResolvedValueOnce(
        mockResponse(200, SOAP_FAULT_BODY),
      );

      await expect(
        client.submit('SO301000', [
          { fieldName: 'OrderNbr', objectName: 'Document', value: 'INVALID' },
        ]),
      ).rejects.toThrow('SOAP Submit fault: Record not found');
    });
  });

  // -- logout() -----------------------------------------------------------

  describe('logout()', () => {
    it('sends Logout SOAPAction', async () => {
      // Login first
      mockRequest.mockResolvedValueOnce(
        mockResponse(200, LOGIN_SUCCESS_BODY, {
          'set-cookie': '.ASPXAUTH=abc123; path=/',
        }),
      );
      await client.login('SO301000');
      vi.clearAllMocks();

      mockRequest.mockResolvedValueOnce(
        mockResponse(200, LOGOUT_SUCCESS_BODY),
      );

      await client.logout('SO301000');

      expect(mockRequest).toHaveBeenCalledTimes(1);
      const [url, opts] = mockRequest.mock.calls[0]!;
      expect(url).toBe('https://test.acumatica.com/Soap/SO301000.asmx');
      expect(opts.headers.SOAPAction).toBe('"http://www.acumatica.com/typed/Logout"');
    });

    it('does not throw on logout failure', async () => {
      // Login first
      mockRequest.mockResolvedValueOnce(
        mockResponse(200, LOGIN_SUCCESS_BODY, {
          'set-cookie': '.ASPXAUTH=abc123; path=/',
        }),
      );
      await client.login('SO301000');
      vi.clearAllMocks();

      mockRequest.mockRejectedValueOnce(new Error('Network error'));

      // Should not throw
      await expect(client.logout('SO301000')).resolves.toBeUndefined();
    });
  });

  // -- getSchema() --------------------------------------------------------

  describe('getSchema()', () => {
    it('sends GetSchema SOAPAction and returns XML', async () => {
      // Login first
      mockRequest.mockResolvedValueOnce(
        mockResponse(200, LOGIN_SUCCESS_BODY, {
          'set-cookie': '.ASPXAUTH=abc123; path=/',
        }),
      );
      await client.login('SO301000');
      vi.clearAllMocks();

      mockRequest.mockResolvedValueOnce(
        mockResponse(200, SCHEMA_SUCCESS_BODY),
      );

      const result = await client.getSchema('SO301000');

      expect(result).toContain('GetSchemaResult');
      expect(result).toContain('Document');
      const [, opts] = mockRequest.mock.calls[0]!;
      expect(opts.headers.SOAPAction).toBe('"http://www.acumatica.com/typed/GetSchema"');
    });
  });

  // -- allocateLot() ------------------------------------------------------

  describe('allocateLot()', () => {
    it('executes correct two-submit sequence for single lot', async () => {
      // Login
      mockRequest.mockResolvedValueOnce(
        mockResponse(200, LOGIN_SUCCESS_BODY, {
          'set-cookie': '.ASPXAUTH=abc123; path=/',
        }),
      );
      // Submit #1 (navigate)
      mockRequest.mockResolvedValueOnce(
        mockResponse(200, SUBMIT_SUCCESS_BODY),
      );
      // Submit #2 (set lot + save)
      mockRequest.mockResolvedValueOnce(
        mockResponse(200, SUBMIT_SUCCESS_BODY),
      );
      // Logout
      mockRequest.mockResolvedValueOnce(
        mockResponse(200, LOGOUT_SUCCESS_BODY),
      );

      const result = await client.allocateLot({
        orderType: 'SO',
        orderNbr: 'S006083',
        lineNbr: '1',
        lots: [{ lotSerialNbr: '000952271' }],
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('000952271');
      expect(result.message).toContain('S006083');

      // Verify 4 calls: login, navigate submit, set-lot submit, logout.
      // Split is load-bearing (soap-client.ts:386-390) — single-submit Save
      // fires before navigation completes and Acumatica inserts new records
      // on a blank form.
      expect(mockRequest).toHaveBeenCalledTimes(4);

      // mock.calls[1] = navigate submit: OrderType + OrderNbr only
      const navigateBody = mockRequest.mock.calls[1]![1].body as string;
      expect(navigateBody).toContain('<FieldName>OrderType</FieldName>');
      expect(navigateBody).toContain('<Value>SO</Value>');
      expect(navigateBody).toContain('<FieldName>OrderNbr</FieldName>');
      expect(navigateBody).toContain('<Value>S006083</Value>');
      expect(navigateBody).not.toContain('LineNbr');
      expect(navigateBody).not.toContain('LotSerialNbr');
      expect(navigateBody).not.toContain('<FieldName>Save</FieldName>');

      // mock.calls[2] = set-lot submit: LineNbr + LotSerialNbr + Save, in order
      const setLotBody = mockRequest.mock.calls[2]![1].body as string;
      expect(setLotBody).toContain('<FieldName>LineNbr</FieldName>');
      expect(setLotBody).toContain('<Value>1</Value>');
      expect(setLotBody).toContain('<FieldName>LotSerialNbr</FieldName>');
      expect(setLotBody).toContain('<Value>000952271</Value>');
      expect(setLotBody).toContain('<FieldName>Save</FieldName>');

      const lineNbrIdx = setLotBody.indexOf('LineNbr');
      const lotIdx = setLotBody.indexOf('LotSerialNbr');
      const saveIdx = setLotBody.indexOf('Save');
      expect(lineNbrIdx).toBeLessThan(lotIdx);
      expect(lotIdx).toBeLessThan(saveIdx);
    });

    it('returns failure on SOAP fault without throwing', async () => {
      // Login
      mockRequest.mockResolvedValueOnce(
        mockResponse(200, LOGIN_SUCCESS_BODY, {
          'set-cookie': '.ASPXAUTH=abc123; path=/',
        }),
      );
      // Submit — fault
      mockRequest.mockResolvedValueOnce(
        mockResponse(200, SOAP_FAULT_BODY),
      );
      // Logout
      mockRequest.mockResolvedValueOnce(
        mockResponse(200, LOGOUT_SUCCESS_BODY),
      );

      const result = await client.allocateLot({
        orderType: 'SO',
        orderNbr: 'S006083',
        lineNbr: '1',
        lots: [{ lotSerialNbr: 'BADLOT' }],
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Record not found');
      // Should still logout (3 calls total)
      expect(mockRequest).toHaveBeenCalledTimes(3);
    });

    it('returns failure for empty lots array', async () => {
      const result = await client.allocateLot({
        orderType: 'SO',
        orderNbr: 'S006083',
        lineNbr: '1',
        lots: [],
      });

      expect(result.success).toBe(false);
      expect(result.message).toBe('No lots provided');
      // No HTTP calls should be made
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('returns failure for multi-lot (not yet supported)', async () => {
      const result = await client.allocateLot({
        orderType: 'SO',
        orderNbr: 'S006083',
        lineNbr: '1',
        lots: [
          { lotSerialNbr: 'LOT1' },
          { lotSerialNbr: 'LOT2' },
        ],
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Multi-lot');
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('does not send Quantity alongside LotSerialNbr (Acumatica re-splits lot assignment)', async () => {
      // Guards the invariant documented at soap-client.ts:357-360: passing
      // Quantity in the same Submit as LotSerialNbr causes Acumatica to
      // re-evaluate the split, discarding the lot assignment. allocateLot
      // accepts lots[].quantity for forward-compat with multi-lot (see TODO
      // at soap-client.ts:363) but must NOT forward it on single-lot.
      // Login
      mockRequest.mockResolvedValueOnce(
        mockResponse(200, LOGIN_SUCCESS_BODY, {
          'set-cookie': '.ASPXAUTH=abc123; path=/',
        }),
      );
      // Submit (navigate)
      mockRequest.mockResolvedValueOnce(
        mockResponse(200, SUBMIT_SUCCESS_BODY),
      );
      // Submit (set lot + save)
      mockRequest.mockResolvedValueOnce(
        mockResponse(200, SUBMIT_SUCCESS_BODY),
      );
      // Logout
      mockRequest.mockResolvedValueOnce(
        mockResponse(200, LOGOUT_SUCCESS_BODY),
      );

      await client.allocateLot({
        orderType: 'SO',
        orderNbr: 'S006083',
        lineNbr: '1',
        lots: [{ lotSerialNbr: '000952271', quantity: 50 }],
      });

      // mock.calls[0] = login, [1] = navigate submit, [2] = set-lot submit, [3] = logout
      const navigateBody = mockRequest.mock.calls[1]![1].body as string;
      const setLotBody = mockRequest.mock.calls[2]![1].body as string;
      expect(navigateBody).not.toContain('Quantity');
      expect(navigateBody).not.toContain('<Value>50</Value>');
      expect(setLotBody).toContain('<FieldName>LotSerialNbr</FieldName>');
      expect(setLotBody).not.toContain('<FieldName>Quantity</FieldName>');
      expect(setLotBody).not.toContain('<Value>50</Value>');
    });

    it('always calls logout even on submit failure', async () => {
      // Login
      mockRequest.mockResolvedValueOnce(
        mockResponse(200, LOGIN_SUCCESS_BODY, {
          'set-cookie': '.ASPXAUTH=abc123; path=/',
        }),
      );
      // Submit — network error
      mockRequest.mockRejectedValueOnce(new Error('Connection reset'));
      // Logout
      mockRequest.mockResolvedValueOnce(
        mockResponse(200, LOGOUT_SUCCESS_BODY),
      );

      const result = await client.allocateLot({
        orderType: 'SO',
        orderNbr: 'S006083',
        lineNbr: '1',
        lots: [{ lotSerialNbr: '000952271' }],
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Connection reset');
      // 3 calls: login, submit (failed), logout
      expect(mockRequest).toHaveBeenCalledTimes(3);
    });
  });

  // -- export() -----------------------------------------------------------

  const EXPORT_SUCCESS_BODY = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <ExportResponse xmlns="http://www.acumatica.com/typed/">
      <ExportResult>
        <ArrayOfString>
          <string>Operation</string>
          <string>ChangeDate</string>
          <string>UserName</string>
          <string>BatchID</string>
        </ArrayOfString>
        <ArrayOfString>
          <string>Update</string>
          <string>3/26/2026 2:15:00 PM</string>
          <string>sarah</string>
          <string>42</string>
        </ArrayOfString>
        <ArrayOfString>
          <string>Insert</string>
          <string>3/26/2026 3:00:00 PM</string>
          <string>kevin</string>
          <string>43</string>
        </ArrayOfString>
      </ExportResult>
    </ExportResponse>
  </soap:Body>
</soap:Envelope>`;

  const EXPORT_EMPTY_BODY = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <ExportResponse xmlns="http://www.acumatica.com/typed/">
      <ExportResult />
    </ExportResponse>
  </soap:Body>
</soap:Envelope>`;

  describe('exportScreen()', () => {
    it('sends Export SOAPAction and parses ArrayOfString rows', async () => {
      mockRequest.mockResolvedValueOnce(
        mockResponse(200, LOGIN_SUCCESS_BODY, {
          'set-cookie': '.ASPXAUTH=abc123; path=/',
        }),
      );
      await client.login('SM205530');
      vi.clearAllMocks();

      mockRequest.mockResolvedValueOnce(
        mockResponse(200, EXPORT_SUCCESS_BODY),
      );

      const commands: SoapCommand[] = [
        { fieldName: 'ScreenID', objectName: 'Filter', value: 'SO301000', commit: true, type: 'Value' },
        { fieldName: 'Operation', objectName: 'Changes', type: 'Field' },
        { fieldName: 'ChangeDate', objectName: 'Changes', type: 'Field' },
        { fieldName: 'UserName', objectName: 'Changes', type: 'Field' },
        { fieldName: 'BatchID', objectName: 'Changes', type: 'Field' },
      ];

      const rows = await client.exportScreen('SM205530', commands, 5000);

      expect(mockRequest).toHaveBeenCalledTimes(1);
      const [url, opts] = mockRequest.mock.calls[0]!;
      expect(url).toBe('https://test.acumatica.com/Soap/SM205530.asmx');
      expect(opts.headers.SOAPAction).toBe('"http://www.acumatica.com/typed/Export"');
      expect(opts.headers['Cookie']).toBe('.ASPXAUTH=abc123');

      expect(opts.body).toContain('<tns:Export>');
      expect(opts.body).toContain('<tns:topCount>5000</tns:topCount>');
      expect(opts.body).toContain('<tns:includeHeaders>true</tns:includeHeaders>');

      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        Operation: 'Update',
        ChangeDate: '3/26/2026 2:15:00 PM',
        UserName: 'sarah',
        BatchID: '42',
      });
      expect(rows[1]).toEqual({
        Operation: 'Insert',
        ChangeDate: '3/26/2026 3:00:00 PM',
        UserName: 'kevin',
        BatchID: '43',
      });
    });

    it('returns empty array when no data rows', async () => {
      mockRequest.mockResolvedValueOnce(
        mockResponse(200, LOGIN_SUCCESS_BODY, {
          'set-cookie': '.ASPXAUTH=abc123; path=/',
        }),
      );
      await client.login('SM205530');
      vi.clearAllMocks();

      mockRequest.mockResolvedValueOnce(
        mockResponse(200, EXPORT_EMPTY_BODY),
      );

      const rows = await client.exportScreen('SM205530', [], 100);
      expect(rows).toEqual([]);
    });

    it('throws on SOAP fault', async () => {
      mockRequest.mockResolvedValueOnce(
        mockResponse(200, LOGIN_SUCCESS_BODY, {
          'set-cookie': '.ASPXAUTH=abc123; path=/',
        }),
      );
      await client.login('SM205530');
      vi.clearAllMocks();

      mockRequest.mockResolvedValueOnce(
        mockResponse(200, SOAP_FAULT_BODY),
      );

      await expect(
        client.exportScreen('SM205530', [], 100),
      ).rejects.toThrow('SOAP Export fault: Record not found');
    });
  });
});
