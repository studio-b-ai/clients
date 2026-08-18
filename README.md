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

#### Outgoing-email CRM logging

`@studio-b-ai/clients/hubspot/recipes` exports `resolveOutgoingEmailRecipients`,
`recordOutgoingEmail`, and `logOutgoingEmailToCrm` — a caller defaults
`logToHubspot` ON for external recipients, so agent-sent business email is
logged to the CRM by construction rather than by opt-in.

Two-phase contract, so a caller can fail CLOSED before it ever sends:

```ts
import { HubSpotClient } from '@studio-b-ai/clients/hubspot';
import { resolveOutgoingEmailRecipients, recordOutgoingEmail, HubSpotEmailLogError } from '@studio-b-ai/clients/hubspot/recipes';

const hs = new HubSpotClient({ accessToken: process.env.HUBSPOT_TOKEN! });

// 1. BEFORE sending — throws HubSpotEmailLogError{stage:'resolve'} if a
//    recipient contact can't be resolved. Do not send on that path.
const resolved = await resolveOutgoingEmailRecipients(hs, { to, cc });

await sendViaGraph(/* ... */); // the caller's own send

// 2. AFTER sending — throws HubSpotEmailLogError{stage:'record'} on failure;
//    by this point the email is already sent, so report "sent but not
//    logged" loudly with err.contactIds rather than pretending it worked.
try {
  await recordOutgoingEmail(hs, resolved, { fromEmail, subject, textBody });
} catch (err) {
  if (err instanceof HubSpotEmailLogError) { /* ... */ }
}
```

`logOutgoingEmailToCrm(hs, { fromEmail, to, cc, subject, textBody, htmlBody })`
composes both phases for a caller that doesn't interleave its own send
between them. `{ skipped: 'all-internal' }` comes back with zero HubSpot
calls when every recipient's domain is in `DEFAULT_INTERNAL_EMAIL_DOMAINS`
(override via `internalDomains`).

**Preferred entrypoint — `sendOutgoingEmailTracked`** wraps ANY send strategy
in the by-construction law (resolve → send → record) and returns one receipt:

```ts
import { sendOutgoingEmailTracked } from '@studio-b-ai/clients/hubspot/recipes';

const receipt = await sendOutgoingEmailTracked(
  hs,
  { fromEmail, to, cc, subject, textBody, htmlBody /*, logExempt?, mode? */ },
  () => ms.sendMessage({ to, cc, subject, body: htmlBody, userEmail: fromEmail }), // the pluggable send
);
// receipt = { sent: true, send, hubspot: { logged: true, engagementId, contactIds, ... }
//         |  { logged: false, skipped: 'all-internal' | 'exempt' }
//         |  { logged: false, stage: 'resolve' | 'record', error, contactIds } }
```

- `mode: 'enforce'` (default) — an unresolvable recipient throws
  `HubSpotEmailLogError{stage:'resolve'}` BEFORE `send()` runs (nothing goes
  out untracked). `mode: 'warn'` sends anyway and the receipt carries the error
  (degrade mode; the caller alerts).
- `logExempt: '<reason>'` — send with zero HubSpot calls (transactional
  do-not-reply etc.); the reason rides in the receipt.
- A `record` failure after a successful send never throws — the receipt says
  `logged: false, stage: 'record'`; surface it loudly, never as success.
- Owner attribution tries the exact sender, then the same local-part on each
  internal domain (`ownerEmailCandidates` to override).

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
