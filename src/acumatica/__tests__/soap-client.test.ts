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
      <GetSchemaResult><Screen><ObjectName>OrderSummary</ObjectName></Screen></GetSchemaResult>
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
        { fieldName: 'OrderType', objectName: 'OrderSummary', value: 'SO', commit: true },
        { fieldName: 'OrderNbr', objectName: 'OrderSummary', value: '000123' },
      ];

      await client.submit('SO301000', commands);

      expect(mockRequest).toHaveBeenCalledTimes(1);
      const [url, opts] = mockRequest.mock.calls[0]!;
      expect(url).toBe('https://test.acumatica.com/Soap/SO301000.asmx');
      expect(opts.headers.SOAPAction).toBe('"http://www.acumatica.com/typed/Submit"');
      expect(opts.headers['Cookie']).toBe('.ASPXAUTH=abc123');
      // Check command XML
      expect(opts.body).toContain('<FieldName>OrderType</FieldName>');
      expect(opts.body).toContain('<ObjectName>OrderSummary</ObjectName>');
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
          { fieldName: 'OrderNbr', objectName: 'OrderSummary', value: 'INVALID' },
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
      expect(result).toContain('OrderSummary');
      const [, opts] = mockRequest.mock.calls[0]!;
      expect(opts.headers.SOAPAction).toBe('"http://www.acumatica.com/typed/GetSchema"');
    });
  });

  // -- allocateLot() ------------------------------------------------------

  describe('allocateLot()', () => {
    it('executes correct command sequence for single lot', async () => {
      // Login
      mockRequest.mockResolvedValueOnce(
        mockResponse(200, LOGIN_SUCCESS_BODY, {
          'set-cookie': '.ASPXAUTH=abc123; path=/',
        }),
      );
      // Submit
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

      // Verify 3 calls: login, submit, logout
      expect(mockRequest).toHaveBeenCalledTimes(3);

      // Verify submit body has all commands in correct order
      const submitBody = mockRequest.mock.calls[1]![1].body as string;
      expect(submitBody).toContain('<Value>SO</Value>');
      expect(submitBody).toContain('<Value>S006083</Value>');
      expect(submitBody).toContain('<Value>1</Value>');
      expect(submitBody).toContain('<Value>000952271</Value>');
      // Save command should be last
      expect(submitBody).toContain('<FieldName>Save</FieldName>');

      // Verify order of commands: OrderType before OrderNbr before LineNbr before LotSerialNbr before Save
      const orderTypeIdx = submitBody.indexOf('OrderType');
      const orderNbrIdx = submitBody.indexOf('OrderNbr');
      const lineNbrIdx = submitBody.indexOf('LineNbr');
      const lotIdx = submitBody.indexOf('LotSerialNbr');
      const saveIdx = submitBody.indexOf('Save');
      expect(orderTypeIdx).toBeLessThan(orderNbrIdx);
      expect(orderNbrIdx).toBeLessThan(lineNbrIdx);
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

    it('includes quantity in commands when specified', async () => {
      // Login
      mockRequest.mockResolvedValueOnce(
        mockResponse(200, LOGIN_SUCCESS_BODY, {
          'set-cookie': '.ASPXAUTH=abc123; path=/',
        }),
      );
      // Submit
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

      const submitBody = mockRequest.mock.calls[1]![1].body as string;
      expect(submitBody).toContain('<FieldName>Quantity</FieldName>');
      expect(submitBody).toContain('<Value>50</Value>');
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
});
