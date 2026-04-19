# Plans

Design and implementation plans for `@studio-b-ai/clients` live in the **consumer monorepo** (`studio-b-ai/studiob`), not in this repo.

## Why cross-repo

This SDK was extracted from `studio-b-ai/studiob` on 2026-04-18. The extraction design + plan were written in the consumer repo's `docs/superpowers/` tree (where Studio B's planning skill stores specs and plans) and never needed to move — the plans describe the extraction itself, and future consumer-facing SDK work will continue to be planned from the consumer side since that's where rollout, lockfile bumps, and integration testing happen.

Rule of thumb: if a plan is about **how consumers adopt an SDK change**, it belongs in the consumer repo. If a plan is purely about **internal SDK structure** (module layout, build system, release tooling), a future plan would land in this repo under `docs/plans/`.

## Current plans

- **Extraction design spec (2026-04-18)** — why the SDK was extracted from the monorepo, what sigstore provenance unlocks, branch protection posture: [studio-b-ai/studiob — docs/superpowers/specs/2026-04-18-clients-extraction-design.md](https://github.com/studio-b-ai/studiob/blob/main/docs/superpowers/specs/2026-04-18-clients-extraction-design.md)
- **Extraction implementation plan (2026-04-18)** — step-by-step git filter-repo, npm publish setup, consumer migration: [studio-b-ai/studiob — docs/superpowers/plans/2026-04-18-clients-extraction-plan.md](https://github.com/studio-b-ai/studiob/blob/main/docs/superpowers/plans/2026-04-18-clients-extraction-plan.md)

## Related

- Current status + live consumers: [../status.md](../status.md)
- Repo overview: [../../README.md](../../README.md)
