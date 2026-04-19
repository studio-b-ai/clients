# @studio-b-ai/clients — Status

Mirror of the Claude memory file `project_clients-sdk.md` on Kevin's workstation. Authoritative source for "what version is live, who consumes it, how to adopt it." Update when a release ships or a new consumer lands.

## Current version

**0.2.0** — first release under `studio-b-ai/clients`, published 2026-04-18 with `npm publish --provenance` (sigstore + SLSA attestation). Pre-0.2.0 history was preserved via `git filter-repo --subdirectory-filter packages/clients` off the old `studio-b-ai/studiob` monorepo path.

## Live consumers

All pin `^0.2.0` from npm (no workspace linking, no git deps):

| Consumer repo | Package path | Notes |
|---|---|---|
| `studio-b-ai/studiob` | `packages/mcp` | Core MCP framework |
| `studio-b-ai/studiob` | `packages/cli` | Operator CLI |
| `studio-b-ai/studiob` | `packages/api` | Internal API layer |
| `studio-b-ai/studiob` | `packages/mcp-acumatica` | Acumatica MCP server |
| `studio-b-ai/studiob` | `apps/server` | Main server (Railway) |

No external consumers yet. VARs and Bolt extension authors are the expected next wave.

## Acceptance pattern (how new consumers adopt it)

```bash
npm install @studio-b-ai/clients
```

Then import per-module:

```ts
import { AcumaticaSessionPool } from '@studio-b-ai/clients/acumatica';
import { HubSpotClient } from '@studio-b-ai/clients/hubspot';
```

Node 22+, ESM only. No CJS build.

## SDK change workflow

SDK edits now require **two PRs**:

1. PR in `studio-b-ai/clients` — ships the new version (bump `package.json`, update `CHANGELOG.md`, merge, publish runs on tag).
2. PR in `studio-b-ai/studiob` — bumps consumer `^x.y.z` constraints and regenerates `package-lock.json`.

Never publish from a feature branch. `publish` status check is required on main.

## Branch protection (main)

- 2 approving reviewers required
- Signed commits required
- Linear history enforced
- Force-push + deletions blocked
- Admin-enforced (no bypass)
- `publish` status check required

## Rotation

NPM_TOKEN rotation is scheduled via Claude remote trigger `trig_01WwCco345fDH2RfKstpE6Ct`. No fixed rotate-by date — rotates on the trigger cadence.

## Outstanding drift (tracked separately)

`packages/mcp` and `packages/api` in `studio-b-ai/studiob` have pre-existing tsc type errors (SDK signature drift in `src/tools/acumatica.ts` and `src/tools/github.ts`; hono `TypedResponse` mismatch in `routes/maintenance.ts`). `npx turbo run build` passes 7/7 because tsup doesn't run strict tsc. Tracked at [studio-b-ai/studiob#54](https://github.com/studio-b-ai/studiob/issues/54).

## Links

- npm: https://www.npmjs.com/package/@studio-b-ai/clients
- Consumer migration PR: [studio-b-ai/studiob#53](https://github.com/studio-b-ai/studiob/pull/53)
- Dockerfile hotfix PR: [studio-b-ai/studiob#58](https://github.com/studio-b-ai/studiob/pull/58)
- CLAUDE.md update PR: [studio-b-ai/studiob#59](https://github.com/studio-b-ai/studiob/pull/59)
- Plans: see [docs/plans/README.md](./plans/README.md)
