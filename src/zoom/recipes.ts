/**
 * Zoom shared recipes -- standalone functions that take a client instance.
 *
 * Reusable patterns extracted from provisioning-agent.
 * Import as `@studio-b-ai/clients/zoom/recipes`.
 */

import type { ZoomClient } from './client.js';

/**
 * Provision Zoom Phone for a user by email.
 *
 * Steps:
 * 1. Look up Zoom user by email
 * 2. Enable phone for the user
 * 3. Assign calling plan (409 = already assigned, ignored)
 * 4. Return phone user details with assigned numbers
 */
export async function provisionPhone(
  client: Pick<ZoomClient, 'getUser' | 'request' | 'getPhoneUser'>,
  email: string,
  callingPlanType: number,
): Promise<any> {
  // Step 1: Look up user
  const user = await client.getUser(email);

  // Step 2: Enable phone
  await client.request('POST', '/phone/users', {
    user_id: user.id,
  });

  // Step 3: Assign calling plan (409 = already assigned)
  try {
    await client.request('POST', `/phone/users/${user.id}/calling_plans`, {
      calling_plans: [{ type: callingPlanType }],
    });
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (!msg.includes('409')) throw err;
  }

  // Step 4: Return phone user details
  return client.getPhoneUser(user.id);
}

/**
 * Deprovision Zoom Phone for a user by email.
 *
 * Steps:
 * 1. Look up Zoom user by email
 * 2. Delete phone provisioning
 */
export async function deprovisionPhone(
  client: Pick<ZoomClient, 'getUser' | 'request'>,
  email: string,
): Promise<void> {
  const user = await client.getUser(email);
  await client.request('DELETE', `/phone/users/${user.id}`);
}
