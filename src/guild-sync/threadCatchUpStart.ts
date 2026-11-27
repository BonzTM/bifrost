import type { Client as FluxerClient } from '@fluxerjs/core';
import type { Client as DiscordClient } from 'discord.js';
import type { AddonLogger } from '../addons/isolation';
import { SEND_INTERVAL_MS } from '../history/limits';
import type { CatchUpConfig } from '../relay-extras/catchUp/config';
import type { LinkedGuild } from './cycle';
import {
    ThreadCatchUp,
    type ThreadCatchUpLimits,
    type ThreadCatchUpStore,
} from './threadCatchUp';
import {
    discordThreadSource,
    fluxerThreadSource,
} from './threadCatchUpSources';
import type { ThreadRelay } from './threadRelay';

export const THREAD_CATCH_UP_LIMITS: ThreadCatchUpLimits = {
    maxThreads: 500,
    fetchTimeoutMs: 30_000,
    budgetMs: 10 * 60_000,
    // Fluxer allows 60 webhook messages a minute per webhook
    // (src/history/limits.ts:5-6).
    sendIntervalMs: SEND_INTERVAL_MS,
};

export interface ThreadCatchUpStartDeps {
    readonly config: CatchUpConfig;
    readonly relay: Pick<ThreadRelay, 'holdNew' | 'releaseHeld' | 'caughtUp'>;
    readonly store: ThreadCatchUpStore;
    readonly discordClient: DiscordClient;
    readonly fluxerClientRef: { readonly current: FluxerClient | null };
    readonly listGuildLinks: () => Promise<readonly LinkedGuild[]>;
    readonly commandPrefix: string;
    /** Runs the pass inside the add-on's isolation boundary. */
    readonly isolate: (pass: () => Promise<void>) => Promise<unknown>;
    readonly logger: AddonLogger;
    readonly limits?: ThreadCatchUpLimits;
}

const realSleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Holds new live thread messages, catches up what threads missed, then
 * relays the held ones. Call it right after the thread relay starts
 * listening. Resolves when done; never rejects.
 */
export async function startThreadCatchUp(
    deps: ThreadCatchUpStartDeps
): Promise<void> {
    if (!deps.config.enabled) return;
    deps.relay.holdNew();
    const startedAt = new Date();
    try {
        await deps.isolate(() => runPass(deps, startedAt));
    } catch (error) {
        deps.logger.error('[catch-up] Thread catch-up failed', error);
    } finally {
        await deps.relay.releaseHeld().catch((error: unknown) => {
            deps.logger.error('[catch-up] Held thread messages failed', error);
        });
    }
}

async function runPass(deps: ThreadCatchUpStartDeps, startedAt: Date) {
    const began = Date.now();
    const runner = new ThreadCatchUp({
        config: deps.config,
        limits: deps.limits ?? THREAD_CATCH_UP_LIMITS,
        sources: [
            discordThreadSource(
                deps.discordClient,
                deps.listGuildLinks,
                deps.commandPrefix
            ),
            fluxerThreadSource(
                deps.fluxerClientRef,
                deps.listGuildLinks,
                deps.commandPrefix
            ),
        ],
        store: deps.store,
        relay: (from, event, raw) => deps.relay.caughtUp(from, event, raw),
        startedAt,
        now: Date.now,
        sleep: realSleep,
        logger: deps.logger,
    });
    const s = await runner.run();
    const seconds = Math.round((Date.now() - began) / 1000);
    deps.logger.info(
        `[catch-up] Threads done in ${seconds}s: ${s.threads} threads with missed messages, sent to the thread relay ${s.relayed}, skipped ${s.skipped}, failed ${s.failed}`
    );
    if (s.unfinished > 0) {
        deps.logger.warn(
            `[catch-up] Time budget ran out; ${s.unfinished} threads were not caught up`
        );
    }
}
