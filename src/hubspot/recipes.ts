/**
 * HubSpot shared recipes -- standalone functions that take a client instance.
 *
 * Reusable patterns extracted from webhook-router sync workers.
 * Import as `@studio-b-ai/clients/hubspot/recipes`.
 */

import type { HubSpotClient } from './client.js';
import { DEFAULT_INTERNAL_EMAIL_DOMAINS } from './client.js';

/**
 * Upsert a CRM object by searching on a unique property.
 * Returns { id, created } indicating whether a new record was created.
 */
export async function upsertByProperty(
  client: Pick<HubSpotClient, 'searchObjects' | 'createObject' | 'updateObject'>,
  objectType: string,
  propName: string,
  propValue: string,
  properties: Record<string, string>,
): Promise<{ id: string; created: boolean }> {
  const search = await client.searchObjects(objectType, {
    filterGroups: [
      {
        filters: [
          { propertyName: propName, operator: 'EQ', value: propValue },
        ],
      },
    ],
    limit: 1,
  });

  if (search.total > 0 && search.results.length > 0) {
    const existingId = search.results[0].id;
    await client.updateObject(objectType, existingId, properties);
    return { id: existingId, created: false };
  }

  const created = await client.createObject(objectType, properties);
  return { id: created.id, created: true };
}

/**
 * Associate two CRM objects using the v4 associations API.
 * Accesses the client's private fetch method to make the PUT call.
 */
export async function associateObjects(
  client: HubSpotClient,
  fromType: string,
  fromId: string,
  toType: string,
  toId: string,
  assocTypeId: number,
): Promise<void> {
  await (client as any).fetch(
    'PUT',
    `/crm/v4/objects/${fromType}/${fromId}/associations/${toType}/${toId}`,
    [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: assocTypeId }],
  );
}

/**
 * Build a Map<stageLabel, stageId> for a specific pipeline.
 * Useful for status mapping in sync workers.
 */
export async function pipelineStageMap(
  client: Pick<HubSpotClient, 'listPipelines'>,
  objectType: string,
  pipelineId: string,
): Promise<Map<string, string>> {
  const response = await client.listPipelines(objectType);
  const pipeline = response.results.find(
    (p: any) => p.pipelineId === pipelineId,
  );

  if (!pipeline) {
    throw new Error(`Pipeline ${pipelineId} not found for ${objectType}`);
  }

  const map = new Map<string, string>();
  for (const stage of pipeline.stages) {
    map.set(stage.label, stage.stageId);
  }
  return map;
}

/**
 * Outgoing-email CRM logging (Kevin 8/18, via the CTO seat — agent-sent
 * business email is HubSpot-logged by construction).
 *
 * Two-phase contract, split so a caller can fail CLOSED before it ever sends:
 *   1. `resolveOutgoingEmailRecipients()` — BEFORE the send. Filters out
 *      internal recipients and ensures a HubSpot contact exists for every
 *      external one. Throws `HubSpotEmailLogError{stage:'resolve'}` if a
 *      contact can't be resolved — the caller must NOT send on that path.
 *   2. `recordOutgoingEmail()` — AFTER the send succeeds. Best-effort company
 *      + owner enrichment, then one atomic engagement create. Throws
 *      `HubSpotEmailLogError{stage:'record'}` on failure — by this point the
 *      email is already sent, so the caller reports "sent but not logged"
 *      loudly with the ids rather than pretending nothing happened.
 *
 * `logOutgoingEmailToCrm()` composes both phases for a caller that doesn't
 * need to interleave its own send between them.
 */

/** Thrown when outgoing-email CRM logging fails, naming which phase failed. */
export class HubSpotEmailLogError extends Error {
  readonly stage: 'resolve' | 'record';
  readonly contactIds: string[];

  constructor(stage: 'resolve' | 'record', message: string, contactIds: string[] = []) {
    super(message);
    this.name = 'HubSpotEmailLogError';
    this.stage = stage;
    this.contactIds = contactIds;
  }
}

export type ResolvedOutgoingEmailRecipients =
  | { skipped: 'all-internal' }
  | {
      skipped?: undefined;
      external: string[];
      /**
       * `kind` preserves which line the caller's original send had this
       * address on — 'to' wins when the same address appears in both `to`
       * and `cc` — so `recordOutgoingEmail` can rebuild an accurate
       * `hs_email_headers` split instead of collapsing every resolved
       * contact onto the `to` line.
       */
      contacts: Array<{ email: string; id: string; created: boolean; kind: 'to' | 'cc' }>;
    };

export type LogOutgoingEmailResult =
  | { skipped: 'all-internal' }
  | {
      skipped?: undefined;
      engagementId: string;
      contactIds: string[];
      createdContactIds: string[];
      companyIds: string[];
      ownerId: string | null;
    };

/** The domain part of an email address, lowercased. Plus-tags never affect this. */
function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1).toLowerCase();
}

function isInternalEmail(email: string, internalDomains: string[]): boolean {
  const domain = emailDomain(email);
  return internalDomains.some((d) => d.toLowerCase() === domain);
}

/**
 * Default owner-lookup candidates for a sender: the exact address first, then
 * the same local-part on every internal domain (deduped, order preserved).
 * Exported for tests + callers that want to extend the list.
 */
export function ownerEmailCandidatesFor(fromEmail: string, internalDomains: string[]): string[] {
  const lower = fromEmail.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at === -1) return [lower];
  const local = lower.slice(0, at);
  const out = [lower];
  for (const d of internalDomains) {
    const c = `${local}@${d.toLowerCase()}`;
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * Phase 1 (BEFORE send): classify recipients as internal/external and ensure
 * every external one has a HubSpot contact. Zero HubSpot calls when every
 * recipient is internal. Fail-closed — throws rather than returning a partial
 * result, so a caller resolving before its Graph send does not send on a
 * resolve failure.
 */
export async function resolveOutgoingEmailRecipients(
  hubspot: Pick<HubSpotClient, 'ensureContactByEmail'>,
  input: { to: string[]; cc?: string[]; internalDomains?: string[] },
): Promise<ResolvedOutgoingEmailRecipients> {
  const internalDomains = input.internalDomains ?? DEFAULT_INTERNAL_EMAIL_DOMAINS;

  // Lowercase + dedupe while tracking which line each address was on — 'to'
  // wins when the same address appears in both, since a human reading the
  // sent email would call that recipient "on the To line".
  const kindByEmail = new Map<string, 'to' | 'cc'>();
  for (const email of input.cc ?? []) {
    const lower = email.toLowerCase();
    if (!kindByEmail.has(lower)) kindByEmail.set(lower, 'cc');
  }
  for (const email of input.to ?? []) {
    kindByEmail.set(email.toLowerCase(), 'to');
  }

  const external = [...kindByEmail.keys()].filter((email) => !isInternalEmail(email, internalDomains));

  if (external.length === 0) {
    return { skipped: 'all-internal' };
  }

  const contacts: Array<{ email: string; id: string; created: boolean; kind: 'to' | 'cc' }> = [];
  try {
    // Sequential is fine — capped at a handful of recipients per outgoing email.
    for (const email of external) {
      const { id, created } = await hubspot.ensureContactByEmail(email);
      contacts.push({ email, id, created, kind: kindByEmail.get(email)! });
    }
  } catch (err) {
    throw new HubSpotEmailLogError(
      'resolve',
      `resolveOutgoingEmailRecipients: failed to resolve a recipient contact — refusing to ` +
        `send (fail-closed). Cause: ${err instanceof Error ? err.message : String(err)}`,
      [],
    );
  }

  return { external, contacts };
}

/**
 * Phase 2 (AFTER send): best-effort company + owner enrichment, then one
 * atomic engagement create. `resolved` comes from `resolveOutgoingEmailRecipients`
 * — an `{ skipped: 'all-internal' }` input passes straight through with zero
 * HubSpot calls.
 */
export async function recordOutgoingEmail(
  hubspot: Pick<HubSpotClient, 'getPrimaryCompanyIdForContact' | 'getOwnerIdByEmail' | 'logOutgoingEmail'>,
  resolved: ResolvedOutgoingEmailRecipients,
  input: {
    fromEmail: string;
    subject: string;
    textBody?: string;
    htmlBody?: string;
    sentAt?: Date;
    /**
     * Owner-lookup candidates, tried in order; the first HubSpot owner match wins.
     * Default: `[fromEmail, ...same local-part @ each internal domain]` — staff
     * mailboxes and HubSpot user emails live on DIFFERENT internal domains
     * (live 2026-08-18: sender kevin@asthetik.com, HubSpot owner
     * kevin@heritagefabrics.com → exact-only lookup left the engagement unowned).
     */
    ownerEmailCandidates?: string[];
    /** Internal domains used to derive the default owner candidates. */
    internalDomains?: string[];
  },
): Promise<LogOutgoingEmailResult> {
  if (resolved.skipped === 'all-internal') return { skipped: 'all-internal' };

  const contactIds = resolved.contacts.map((c) => c.id);
  const createdContactIds = resolved.contacts.filter((c) => c.created).map((c) => c.id);

  // Best-effort — a company-association lookup failure must never block
  // logging the email itself (the client already swallows a 404 to null;
  // this also swallows any other error the same way).
  const companyIdSet = new Set<string>();
  for (const contactId of contactIds) {
    try {
      const companyId = await hubspot.getPrimaryCompanyIdForContact(contactId);
      if (companyId) companyIdSet.add(companyId);
    } catch {
      // best-effort — see comment above.
    }
  }
  const companyIds = [...companyIdSet];

  // Best-effort — an owner-lookup failure must never block logging the email.
  // Candidates are tried in order (exact sender first, then the same local-part
  // across the internal domains); the first match wins, so a null result means
  // NONE matched, never that the first one didn't.
  let ownerId: string | null = null;
  const ownerCandidates =
    input.ownerEmailCandidates ??
    ownerEmailCandidatesFor(input.fromEmail, input.internalDomains ?? DEFAULT_INTERNAL_EMAIL_DOMAINS);
  for (const candidate of ownerCandidates) {
    try {
      ownerId = await hubspot.getOwnerIdByEmail(candidate);
    } catch {
      ownerId = null; // best-effort — see comment above; keep trying the next candidate.
    }
    if (ownerId) break;
  }

  // Rebuild the original to/cc split from the resolved contacts' `kind` —
  // a CC'd contact must not be recorded as a To recipient in hs_email_headers
  // (codex P1 pass 1: collapsing to/cc misrepresents the sent email on the
  // HubSpot timeline). `contactIds`/associations above are UNAFFECTED by the
  // split — every resolved contact gets the engagement association either way.
  const to = resolved.contacts.filter((c) => c.kind === 'to').map((c) => c.email);
  const cc = resolved.contacts.filter((c) => c.kind === 'cc').map((c) => c.email);

  let engagement: { id: string };
  try {
    engagement = await hubspot.logOutgoingEmail({
      fromEmail: input.fromEmail,
      to,
      cc,
      subject: input.subject,
      textBody: input.textBody,
      htmlBody: input.htmlBody,
      sentAt: input.sentAt,
      ownerId,
      contactIds,
      companyIds,
    });
  } catch (err) {
    throw new HubSpotEmailLogError(
      'record',
      `recordOutgoingEmail: the email was SENT but the HubSpot engagement create failed — ` +
        `NOT logged. contactIds=[${contactIds.join(', ')}]. Cause: ${err instanceof Error ? err.message : String(err)}`,
      contactIds,
    );
  }

  return { engagementId: engagement.id, contactIds, createdContactIds, companyIds, ownerId };
}

/**
 * Composes `resolveOutgoingEmailRecipients` + `recordOutgoingEmail` for a
 * caller that logs before AND after its send in one call — i.e. it does not
 * need to interleave its own Graph/SMTP send between the two phases. A caller
 * that must not send until recipients are resolved should call the two
 * phases directly instead (see the module doc comment above).
 */
export async function logOutgoingEmailToCrm(
  hubspot: HubSpotClient,
  input: {
    fromEmail: string;
    to: string[];
    cc?: string[];
    subject: string;
    textBody?: string;
    htmlBody?: string;
    sentAt?: Date;
    internalDomains?: string[];
    /** See `recordOutgoingEmail` — owner-lookup candidates (default: sender + same local-part @ internal domains). */
    ownerEmailCandidates?: string[];
  },
): Promise<LogOutgoingEmailResult> {
  const resolved = await resolveOutgoingEmailRecipients(hubspot, {
    to: input.to,
    cc: input.cc,
    internalDomains: input.internalDomains,
  });
  return recordOutgoingEmail(hubspot, resolved, {
    fromEmail: input.fromEmail,
    subject: input.subject,
    textBody: input.textBody,
    htmlBody: input.htmlBody,
    sentAt: input.sentAt,
    ownerEmailCandidates: input.ownerEmailCandidates,
    internalDomains: input.internalDomains,
  });
}
