import { SNOWFLAKE_EPOCH_MS } from '../../fluxer-db/keys';
import type { Side } from '../types';

/**
 * Pure rules for relay catch-up (docs/design/relay-catch-up.md): where a
 * channel's gap starts and which messages in it the live relay would
 * have copied.
 */

const SNOWFLAKE = /^\d{1,20}$/;
const TIMESTAMP_SHIFT = BigInt(22);

/** True for a decimal snowflake ID. */
export function isSnowflake(id: string): boolean {
    return SNOWFLAKE.test(id);
}

/** True when snowflake `a` is newer than `b`. */
export function laterId(a: string, b: string): boolean {
    return BigInt(a) > BigInt(b);
}

/**
 * The largest snowflake made before `at`: an `after` cursor that keeps
 * messages made at `at` or later. Discord and Fluxer share one epoch
 * (src/fluxer-db/keys.ts:21).
 */
export function snowflakeBefore(at: number): string {
    const epoch = Number(SNOWFLAKE_EPOCH_MS);
    if (!Number.isFinite(at) || at <= epoch) return '0';
    const first = BigInt(Math.floor(at) - epoch) << TIMESTAMP_SHIFT;
    return (first - BigInt(1)).toString();
}

/** The newest of the given snowflakes; '0' when there is none. */
export function newestId(ids: readonly (string | null)[]): string {
    let newest = '0';
    for (const id of ids) {
        if (id === null || !isSnowflake(id)) continue;
        if (laterId(id, newest)) newest = id;
    }
    return newest;
}

/** What bounds the start of one side's gap. */
export interface GapBounds {
    /** Newest message of this side bridged before this process started. */
    readonly bridged: string | null;
    /** Newest history copy of this side in the channel (add-ons only). */
    readonly history: string | null;
    /** When the channel link was made: older messages are history's. */
    readonly linkedAt: number;
    /** Now minus BF_RELAY_CATCH_UP_MAX_AGE_HOURS. */
    readonly oldestAllowed: number;
}

/**
 * The `after` cursor for one side: the newest of the last bridged
 * message, the last history copy, the link time and the age limit.
 * Messages older than the link belong to the history add-on, which copies
 * up to the link time (src/history/importer.ts:1336-1374).
 */
export function gapStart(bounds: GapBounds): string {
    return newestId([
        bounds.bridged,
        bounds.history,
        snowflakeBefore(bounds.linkedAt),
        snowflakeBefore(bounds.oldestAllowed),
    ]);
}

/** The facts the skip rules read from one fetched message. */
export interface Candidate {
    readonly id: string;
    readonly authorId: string;
    readonly webhookId: string | null;
    readonly content: string;
    /** A "joined the server" notice (message type 7 on both platforms). */
    readonly isJoin: boolean;
}

/** What the live relay would do with a message, plus catch-up's own rules. */
export type Verdict =
    | 'relay'
    | 'own-bot'
    | 'bridge-webhook'
    | 'command'
    | 'join'
    | 'before-gap';

export const SKIP_VERDICTS = [
    'own-bot',
    'bridge-webhook',
    'command',
    'join',
    'before-gap',
] as const satisfies readonly Exclude<Verdict, 'relay'>[];

/** The context the skip rules compare a message against. */
export interface SkipContext {
    readonly side: Side;
    /** This side's bot user. */
    readonly botUserId: string;
    /** The bridge webhook of this side in the channel link. */
    readonly bridgeWebhookId: string;
    readonly commandPrefix: string;
    readonly afterId: string;
}

/**
 * Applies the live relay's loop guards and command check: own bot
 * (src/discord.ts:286, src/fluxer.ts:294), the link's own webhook
 * (src/discord.ts:288-298, src/fluxer.ts:296-306) and command strings
 * (src/discord.ts:356, src/fluxer.ts:365). Join notices are skipped too:
 * the relay records no message link for them (DiscordToFluxerMessageRelay
 * :113, FluxerToDiscordMessageRelay :91), so a copy could not be told
 * apart from a second one.
 */
export function classify(candidate: Candidate, ctx: SkipContext): Verdict {
    if (!isSnowflake(candidate.id) || !laterId(candidate.id, ctx.afterId))
        return 'before-gap';
    if (candidate.authorId === ctx.botUserId) return 'own-bot';
    if (
        candidate.webhookId !== null &&
        candidate.webhookId === ctx.bridgeWebhookId
    )
        return 'bridge-webhook';
    if (candidate.content.startsWith(ctx.commandPrefix)) return 'command';
    if (candidate.isJoin) return 'join';
    return 'relay';
}

export type SkipCounts = Record<(typeof SKIP_VERDICTS)[number], number>;

export function emptySkipCounts(): SkipCounts {
    return {
        'own-bot': 0,
        'bridge-webhook': 0,
        command: 0,
        join: 0,
        'before-gap': 0,
    };
}

/** The messages to relay, oldest first, and why the others were left. */
export interface Selection<M extends Candidate> {
    readonly relay: readonly M[];
    readonly skipped: SkipCounts;
}

/** Sorts oldest first by snowflake; non-snowflake IDs go first. */
function oldestFirst<M extends Candidate>(messages: readonly M[]): M[] {
    const key = (m: M) => (isSnowflake(m.id) ? BigInt(m.id) : BigInt(-1));
    return [...messages].sort((a, b) => {
        const diff = key(a) - key(b);
        return diff < BigInt(0) ? -1 : diff > BigInt(0) ? 1 : 0;
    });
}

/**
 * Picks the messages one side of a channel missed: at most `limit`, in
 * the order they were posted. Duplicate IDs in a page count once.
 */
export function selectMissed<M extends Candidate>(
    messages: readonly M[],
    ctx: SkipContext,
    limit: number
): Selection<M> {
    const skipped = emptySkipCounts();
    const relay: M[] = [];
    const seen = new Set<string>();
    for (const message of oldestFirst(messages)) {
        if (relay.length >= limit || seen.has(message.id)) continue;
        seen.add(message.id);
        const verdict = classify(message, ctx);
        if (verdict === 'relay') relay.push(message);
        else skipped[verdict] += 1;
    }
    return { relay, skipped };
}
