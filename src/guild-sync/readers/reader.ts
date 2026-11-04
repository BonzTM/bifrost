import { AddonTimeoutError, withTimeout } from '../../addons/host';
import type { ReadResult } from '../health';
import type { SyncKind } from '../ops';
import type { GuildSnapshot } from '../snapshot';

/** Reads one platform over REST. Never reads the gateway cache. */
export interface GuildReader {
    read(guildId: string): Promise<ReadResult>;
    /**
     * Direct lookup for guard 4. True when the API answers Unknown, false
     * when the object exists, null when the lookup itself failed.
     */
    isGone(
        guildId: string,
        kind: SyncKind,
        id: string
    ): Promise<boolean | null>;
}

/** Default time limit for one full structure read. */
export const READ_TIMEOUT_MS = 30_000;

/**
 * Runs a fetch under a time limit and turns every failure into a failed
 * read, so the health gate sees it instead of an exception.
 */
export async function guardedRead(
    label: string,
    timeoutMs: number,
    fetch: () => Promise<ReadResult | GuildSnapshot>
): Promise<ReadResult> {
    try {
        const result = await withTimeout(fetch(), timeoutMs, label);
        return 'ok' in result ? result : { ok: true, snapshot: result };
    } catch (error) {
        if (error instanceof AddonTimeoutError) {
            return { ok: false, reason: 'timeout', detail: error.message };
        }
        const detail = error instanceof Error ? error.message : String(error);
        return { ok: false, reason: 'error', detail };
    }
}

/** Runs a lookup, mapping "unknown object" errors to gone. */
export async function guardedLookup(
    timeoutMs: number,
    lookup: () => Promise<unknown>,
    isUnknown: (error: unknown) => boolean
): Promise<boolean | null> {
    try {
        const found = await withTimeout(lookup(), timeoutMs, 'lookup');
        return found === null || found === undefined;
    } catch (error) {
        return isUnknown(error) ? true : null;
    }
}
