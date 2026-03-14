/**
 * HubSpot shared recipes -- standalone functions that take a client instance.
 *
 * Reusable patterns extracted from webhook-router sync workers.
 * Import as `@studio-b-ai/clients/hubspot/recipes`.
 */

import type { HubSpotClient } from './client.js';

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
