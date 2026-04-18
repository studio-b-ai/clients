# @studio-b-ai/clients

Typed TypeScript clients for the integrations Studio B uses to run Acumatica ERP operations: Acumatica, HubSpot, Railway, GitHub, Slack, Zoom, Microsoft 365, GoDaddy, LinkedIn.

Built for [AcuOps by Studio B](https://acuops.com) and for [Bolt (Continuous Goods WMS)](https://bolt.b.studio) customer extensions.

## Install

```bash
npm install @studio-b-ai/clients
```

Node.js 22+. ESM only.

## Modules

| Import path | What it does |
|---|---|
| `@studio-b-ai/clients/acumatica` | Acumatica session pool, contract API, screen API, recipes |
| `@studio-b-ai/clients/hubspot` | HubSpot CRM: contacts, companies, tickets, deals, projects (0-970) |
| `@studio-b-ai/clients/railway` | Railway GraphQL client — services, variables, deploys |
| `@studio-b-ai/clients/github` | GitHub REST/GraphQL helpers |
| `@studio-b-ai/clients/slack` | Slack Web API client |
| `@studio-b-ai/clients/zoom` | Zoom REST + Phone APIs, recipes |
| `@studio-b-ai/clients/microsoft` | Microsoft Graph (mail, calendar, files) |
| `@studio-b-ai/clients/godaddy` | GoDaddy Domains + DNS |
| `@studio-b-ai/clients/linkedin` | LinkedIn Marketing + Community Management |
| `@studio-b-ai/clients/shared/config` | Shared config loader |
| `@studio-b-ai/clients/shared/encryption` | AES-GCM encryption helpers for credential-at-rest |

## Quick start

### Acumatica

```ts
import { AcumaticaSessionPool } from '@studio-b-ai/clients/acumatica';

const pool = new AcumaticaSessionPool({
  baseUrl: 'https://your-tenant.acumatica.com',
  username: process.env.ACUMATICA_USERNAME!,
  password: process.env.ACUMATICA_PASSWORD!,
  tenant: 'Company',
});

const records = await pool.withSession(async (session) => {
  return session.get('/entity/Default/24.200.001/StockItem', { $top: 10 });
});
```

### HubSpot

```ts
import { HubSpotClient } from '@studio-b-ai/clients/hubspot';

const hs = new HubSpotClient({ accessToken: process.env.HUBSPOT_TOKEN! });
const contact = await hs.contacts.getById('12345');
```

### Railway

```ts
import { RailwayClient } from '@studio-b-ai/clients/railway';

const rw = new RailwayClient({ token: process.env.RAILWAY_TOKEN! });
const services = await rw.listServices({ projectId: 'proj_...' });
```

## About

Built by [Studio B](https://b.studio). Used in production by AcuOps and Bolt.

Source is public for transparency and so AcuOps VARs and Bolt extension authors can see exactly what they're calling into.

## License

MIT — see [LICENSE](./LICENSE).
