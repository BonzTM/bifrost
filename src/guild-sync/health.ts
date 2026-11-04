import type { GuildSnapshot, ObjectCounts } from './snapshot';
import { countObjects } from './snapshot';

/** What a reader returns. A failed read never carries a snapshot. */
export type ReadResult =
    | { readonly ok: true; readonly snapshot: GuildSnapshot }
    | {
          readonly ok: false;
          readonly reason: 'error' | 'timeout' | 'not-ready' | 'unavailable';
          readonly detail: string;
      };

export type GateResult =
    | { readonly ok: true; readonly snapshot: GuildSnapshot }
    | { readonly ok: false; readonly reason: string };

/**
 * Source health gate (safety guard 2). The cycle stops here on any failed
 * or implausible read, so a Discord outage can never look like a server
 * that lost its channels.
 */
export function checkSourceHealth(read: ReadResult): GateResult {
    if (!read.ok) {
        return { ok: false, reason: `source ${read.reason}: ${read.detail}` };
    }
    const { snapshot } = read;
    if (!snapshot.roles.some((role) => role.id === snapshot.everyoneRoleId)) {
        return { ok: false, reason: 'source has no @everyone role' };
    }
    if (snapshot.channels.length === 0) {
        return { ok: false, reason: 'source has no channels' };
    }
    if (snapshot.name.trim() === '') {
        return { ok: false, reason: 'source has no server name' };
    }
    return { ok: true, snapshot };
}

export interface ShrinkLimits {
    /** Share of the last healthy count, 1 to 100. */
    readonly shrinkPercent: number;
    /** Floor, so small servers can still lose a few objects. */
    readonly shrinkMinObjects: number;
}

const SHRINK_KINDS = ['roles', 'channels', 'emojis'] as const;

/**
 * Shrink check (safety guard 3). Trips when roles, channels or emojis drop
 * by more than the larger of `shrinkPercent` and `shrinkMinObjects` since
 * the last healthy snapshot. With no earlier snapshot it passes, because
 * nothing is mapped yet, so nothing can be archived.
 */
export function checkShrink(
    current: GuildSnapshot,
    lastHealthy: ObjectCounts | null,
    limits: ShrinkLimits
): { ok: true } | { ok: false; reason: string } {
    if (limits.shrinkPercent < 1 || limits.shrinkPercent > 100) {
        return { ok: false, reason: 'shrinkPercent is out of range' };
    }
    if (limits.shrinkMinObjects < 0) {
        return { ok: false, reason: 'shrinkMinObjects is negative' };
    }
    if (!lastHealthy) return { ok: true };
    const counts = countObjects(current);
    for (const kind of SHRINK_KINDS) {
        const before = lastHealthy[kind];
        const drop = before - counts[kind];
        const allowed = Math.max(
            Math.floor((before * limits.shrinkPercent) / 100),
            limits.shrinkMinObjects
        );
        if (drop > allowed) {
            return {
                ok: false,
                reason: `${kind} dropped from ${before} to ${counts[kind]}, over the limit of ${allowed}`,
            };
        }
    }
    return { ok: true };
}
