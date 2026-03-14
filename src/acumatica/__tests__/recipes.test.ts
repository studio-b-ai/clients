import { describe, it, expect, vi } from 'vitest';
import {
  gatedQuery,
  getCustomerFull,
  getOrderFull,
  getStockItemFull,
  batchGetByFilter,
  setEntityAttribute,
} from '../recipes.js';

// --- Mock factories ---

function mockClient() {
  return {
    get: vi.fn(),
    put: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  };
}

function mockGate() {
  return {
    withSession: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
  };
}

// --- Tests ---

describe('gatedQuery', () => {
  it('delegates to gate.withSession and returns result', async () => {
    const gate = mockGate();
    const result = await gatedQuery(gate, async () => 42);
    expect(gate.withSession).toHaveBeenCalledOnce();
    expect(result).toBe(42);
  });

  it('propagates errors from the callback', async () => {
    const gate = mockGate();
    await expect(
      gatedQuery(gate, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('propagates errors from withSession itself', async () => {
    const gate = {
      withSession: vi.fn(async () => {
        throw new Error('gate timeout');
      }),
    };
    await expect(gatedQuery(gate, async () => 1)).rejects.toThrow('gate timeout');
  });
});

describe('getCustomerFull', () => {
  it('calls GET /Customer/{id} with correct $expand', async () => {
    const client = mockClient();
    const mockCustomer = { CustomerID: 'C001', CustomerName: 'Acme' };
    client.get.mockResolvedValue(mockCustomer);

    const result = await getCustomerFull(client as any, 'C001');

    expect(client.get).toHaveBeenCalledWith('Customer/C001', {
      $expand: 'MainContact,CreditVerificationRules,Salespersons,Attributes',
    });
    expect(result).toEqual(mockCustomer);
  });
});

describe('getOrderFull', () => {
  it('defaults to SO order type', async () => {
    const client = mockClient();
    client.get.mockResolvedValue({ OrderNbr: '000123' });

    await getOrderFull(client as any, '000123');

    expect(client.get).toHaveBeenCalledWith('SalesOrder/SO/000123', {
      $expand: 'Details,ShippingSettings,FinancialSettings',
    });
  });

  it('accepts custom order type', async () => {
    const client = mockClient();
    client.get.mockResolvedValue({ OrderNbr: '000456' });

    await getOrderFull(client as any, '000456', 'QT');

    expect(client.get).toHaveBeenCalledWith('SalesOrder/QT/000456', {
      $expand: 'Details,ShippingSettings,FinancialSettings',
    });
  });
});

describe('getStockItemFull', () => {
  it('calls GET /StockItem/{id} with correct $expand', async () => {
    const client = mockClient();
    const mockItem = { InventoryID: 'SKU-001' };
    client.get.mockResolvedValue(mockItem);

    const result = await getStockItemFull(client as any, 'SKU-001');

    expect(client.get).toHaveBeenCalledWith('StockItem/SKU-001', {
      $expand: 'Attributes,WarehouseDetails',
    });
    expect(result).toEqual(mockItem);
  });
});

describe('batchGetByFilter', () => {
  it('returns empty array for empty values', async () => {
    const client = mockClient();
    const result = await batchGetByFilter(client as any, 'Customer', 'CustomerID', []);
    expect(result).toEqual([]);
    expect(client.get).not.toHaveBeenCalled();
  });

  it('builds OR filter for a small batch', async () => {
    const client = mockClient();
    client.get.mockResolvedValue([{ CustomerID: 'A' }, { CustomerID: 'B' }]);

    const result = await batchGetByFilter(client as any, 'Customer', 'CustomerID', ['A', 'B']);

    expect(client.get).toHaveBeenCalledOnce();
    expect(client.get).toHaveBeenCalledWith('Customer', {
      $filter: "CustomerID eq 'A' or CustomerID eq 'B'",
    });
    expect(result).toHaveLength(2);
  });

  it('chunks into batches of 100', async () => {
    const client = mockClient();
    // Generate 150 values
    const values = Array.from({ length: 150 }, (_, i) => `V${i}`);
    client.get.mockResolvedValue([]);

    await batchGetByFilter(client as any, 'StockItem', 'InventoryID', values);

    // Should make 2 calls: batch of 100 + batch of 50
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  it('merges additional params into each batch call', async () => {
    const client = mockClient();
    client.get.mockResolvedValue([]);

    await batchGetByFilter(client as any, 'Customer', 'CustomerID', ['A'], {
      $select: 'CustomerID,CustomerName',
    });

    expect(client.get).toHaveBeenCalledWith('Customer', {
      $filter: "CustomerID eq 'A'",
      $select: 'CustomerID,CustomerName',
    });
  });

  it('handles non-array responses by wrapping in array', async () => {
    const client = mockClient();
    client.get.mockResolvedValue({ CustomerID: 'A' });

    const result = await batchGetByFilter(client as any, 'Customer', 'CustomerID', ['A']);
    expect(result).toEqual([{ CustomerID: 'A' }]);
  });
});

describe('setEntityAttribute', () => {
  it('PUTs attribute with value-wrapped body', async () => {
    const client = mockClient();
    client.put.mockResolvedValue({ success: true });

    await setEntityAttribute(client as any, 'StockItem', 'SKU-001', 'HUBSPOTPID', 'abc123');

    expect(client.put).toHaveBeenCalledWith('StockItem/SKU-001', {
      Attributes: [{ AttributeID: { value: 'HUBSPOTPID' }, Value: { value: 'abc123' } }],
    });
  });
});
