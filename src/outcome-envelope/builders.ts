import { Pack, validatePack } from "./pack.js";
import { Outcome, validateOutcome } from "./outcome.js";

/**
 * Build and validate a Pack. Accepts a full Pack-shaped object and fails loudly
 * (via Zod) if any required field is missing or malformed.
 */
export const buildPack = (input: unknown): Pack => validatePack(input);

/**
 * Build and validate an Outcome. Accepts a full Outcome-shaped object and fails
 * loudly (via Zod) if any required field is missing or malformed.
 */
export const buildOutcome = (input: unknown): Outcome => validateOutcome(input);

/**
 * Assert that a received version string is in the list of supported versions.
 * Used by AcuDev / AcuSync to fail fast on unsupported pack_version.
 *
 * @throws Error if received is not in supported
 */
export const assertCompatibleVersion = (
  received: string,
  supported: string[],
): void => {
  if (!supported.includes(received)) {
    throw new Error(
      `Unsupported envelope version "${received}". Supported: [${supported.join(", ")}].`,
    );
  }
};
