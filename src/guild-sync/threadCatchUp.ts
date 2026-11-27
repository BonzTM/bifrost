import type { SnapshotSide } from '../addons/db/schema';
import { withTimeout } from '../addons/host';
import type { AddonLogger } from '../addons/isolation';
import type { CatchUpConfig } from '../relay-extras/catchUp/config';
import {
    laterId,
    newestId,
    snowflakeBefore,
} from '../relay-extras/catchUp/select';
import type { ThreadRelayStore } from './store';
import type { ThreadMessageEvent } from './threadRelay';

/**
 * Thread catch-up: once the thread relay listens, copies the thread and
 * forum post messages it missed while bifrost was down, through the live
 * thread relay (docs/design/relay-catch-up.md). Only active threads are
 * read: a message posted in an archived thread unarchives it.
 */

/** An active thread on one side, as the platform lists it. */
export interface CatchUpThread {
    readonly id: string;
    readonly parentId: string;
    /** The thread's guild on its platform. */
    readonly guildId: string;
    /** The newest message, when the platform says; null when unknown. */
    readonly lastMessageId: string | null;
}

/** A message the relay copies, already through the live skip rules. */
export interface FoundMessage {
    readonly event: ThreadMessageEvent;
    readonly raw: unknown;
}

/** Where catch-up reads one side's threads (threadCatchUpSources.ts). */
export interface ThreadCatchUpSource {
    readonly side: SnapshotSide;
    /** The active threads of the linked guilds, at most `limit`. */
    activeThreads(limit: number): Promise<CatchUpThread[]>;
    /** At most `limit` messages after `afterId` that the relay copies. */
    messagesAfter(
        thread: CatchUpThread,
        afterId: string,
        limit: number
    ): Promise<FoundMessage[]>;
}

export interface ThreadCatchUpLimits {
    /** Upper bound on the threads read per side. */
    readonly maxThreads: number;
    /** Bound on one list request. */
    readonly fetchTimeoutMs: number;
    /** The run stops starting new work after this long. */
    readonly budgetMs: number;
    /** Wait after each relayed message, for the webhook rate limits. */
    readonly sendIntervalMs: number;
}

export type ThreadCatchUpStore = Pick<
    ThreadRelayStore,
    'findThreadPair' | 'findThreadMessage' | 'historyCovers'
> & {
    newestThreadMessage(
        side: SnapshotSide,
        threadId: string,
        before: Date
    ): Promise<string | null>;
};

export interface ThreadCatchUpDeps {
    readonly config: CatchUpConfig;
    readonly limits: ThreadCatchUpLimits;
    readonly sources: readonly ThreadCatchUpSource[];
    readonly store: ThreadCatchUpStore;
    /** The live relay's entry for found messages (ThreadRelay.caughtUp). */
    readonly relay: (
        from: SnapshotSide,
        event: ThreadMessageEvent,
        raw: unknown
    ) => Promise<void>;
    /** When the thread relay started listening: later copies are live. */
    readonly startedAt: Date;
    readonly now: () => number;
    readonly sleep: (ms: number) => Promise<void>;
    readonly logger: AddonLogger;
}

export interface ThreadCatchUpSummary {
    threads: number;
    relayed: number;
    skipped: number;
    failed: number;
    /** Threads left out when the time budget ran out. */
    unfinished: number;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Oldest first, by snowflake. */
export function oldestFirst(messages: readonly FoundMessage[]): FoundMessage[] {
    return [...messages].sort((a, b) => {
        if (a.event.id === b.event.id) return 0;
        return laterId(a.event.id, b.event.id) ? 1 : -1;
    });
}

export class ThreadCatchUp {
    constructor(private readonly deps: ThreadCatchUpDeps) {}

    /** Catches up each side once. Never throws. */
    async run(): Promise<ThreadCatchUpSummary> {
        const summary: ThreadCatchUpSummary = {
            threads: 0,
            relayed: 0,
            skipped: 0,
            failed: 0,
            unfinished: 0,
        };
        const deadline = this.deps.now() + this.deps.limits.budgetMs;
        for (const source of this.deps.sources) {
            try {
                await this.runSide(source, summary, deadline);
            } catch (error) {
                this.deps.logger.warn(
                    `[catch-up] ${source.side} threads: ${errorText(error)}`
                );
            }
        }
        return summary;
    }

    private async runSide(
        source: ThreadCatchUpSource,
        summary: ThreadCatchUpSummary,
        deadline: number
    ): Promise<void> {
        const { limits } = this.deps;
        const threads = await withTimeout(
            source.activeThreads(limits.maxThreads),
            limits.fetchTimeoutMs,
            `[catch-up] ${source.side} active threads`
        );
        for (const [index, thread] of threads.entries()) {
            if (this.deps.now() >= deadline) {
                summary.unfinished += threads.length - index;
                return;
            }
            try {
                await this.runThread(source, thread, summary, deadline);
            } catch (error) {
                summary.failed += 1;
                this.deps.logger.warn(
                    `[catch-up] ${source.side} thread ${thread.id}: ${errorText(error)}`
                );
            }
        }
    }

    /** Where this thread's gap starts: last copy before start, or the age limit. */
    private async gapStart(side: SnapshotSide, threadId: string) {
        const { store, startedAt, config } = this.deps;
        const newest = await store.newestThreadMessage(
            side,
            threadId,
            startedAt
        );
        return newestId([
            newest,
            snowflakeBefore(this.deps.now() - config.maxAgeMs),
        ]);
    }

    private async runThread(
        source: ThreadCatchUpSource,
        thread: CatchUpThread,
        summary: ThreadCatchUpSummary,
        deadline: number
    ): Promise<void> {
        const afterId = await this.gapStart(source.side, thread.id);
        // Nothing newer than the gap start: no request needed.
        if (thread.lastMessageId && !laterId(thread.lastMessageId, afterId))
            return;
        const { config, limits } = this.deps;
        const found = await withTimeout(
            source.messagesAfter(thread, afterId, config.maxMessages),
            limits.fetchTimeoutMs,
            `[catch-up] ${source.side} thread ${thread.id} message list`
        );
        if (found.length === 0) return;
        summary.threads += 1;
        const paired = await this.deps.store.findThreadPair(
            source.side,
            thread.id
        );
        for (const message of oldestFirst(found)) {
            if (this.deps.now() >= deadline) return;
            await this.copyOne(source.side, message, paired !== null, summary);
        }
    }

    /**
     * True for a message catch-up leaves alone. A post's starter has the
     * post's ID: guild-sync posts a Discord one with the post, and a paired
     * Fluxer one was mirrored with its post. An unpaired Fluxer starter
     * goes through, so the relay mirrors its post (threadMirror.ts).
     */
    private async skip(
        side: SnapshotSide,
        event: ThreadMessageEvent,
        paired: boolean
    ): Promise<boolean> {
        const { store } = this.deps;
        if (event.id === event.channelId && (side === 'discord' || paired))
            return true;
        if (await store.findThreadMessage(side, event.id)) return true;
        if (side !== 'discord') return false;
        return (
            (await store.historyCovers?.(event.channelId, event.id)) === true
        );
    }

    private async copyOne(
        side: SnapshotSide,
        message: FoundMessage,
        paired: boolean,
        summary: ThreadCatchUpSummary
    ): Promise<void> {
        try {
            if (await this.skip(side, message.event, paired)) {
                summary.skipped += 1;
                return;
            }
            await this.deps.relay(side, message.event, message.raw);
            summary.relayed += 1;
        } catch (error) {
            summary.failed += 1;
            this.deps.logger.warn(
                `[catch-up] ${side} thread message ${message.event.id}: ${errorText(error)}`
            );
        }
        await this.deps.sleep(this.deps.limits.sendIntervalMs);
    }
}
