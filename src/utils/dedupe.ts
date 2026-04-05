import { createHash } from "crypto";

/**
 * Compute a stable deduplication key for a listing+channel pair.
 * Uses sha256(entityId|channel) so the same listing is never submitted
 * twice to the same channel, regardless of URL changes.
 */
export function computeDedupeKey(entityId: string, channel: string): string {
  return createHash("sha256").update(`${entityId}|${channel}`).digest("hex");
}
