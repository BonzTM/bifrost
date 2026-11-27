import type { Client as FluxerClient } from '@fluxerjs/core';
import type { Client as DiscordClient } from 'discord.js';
import type { AddonLogger } from '../../addons/isolation';
import { SEND_INTERVAL_MS } from '../../history/limits';
import type { Side } from '../types';
import type { CatchUpConfig } from './config';
import {
    createCatchUpHooks,
    RelayGate,
    type AlreadyCopied,
    type CatchUpHooks,
} from './gate';
import { CatchUp, type CatchUpLimits, type CatchUpLink } from './runner';
import { discordSource, fluxerSource } from './sources';
import type { CatchUpStore } from './store';

/**
 * Relay catch-up: once both clients are up, copies what each bridged
 * channel missed while bifrost was down (docs/design/relay-catch-up.md).
 */

export const CATCH_UP_LIMITS: CatchUpLimits = {
    budgetMs: 10 * 60_000,
    fetchTimeoutMs: 30_000,
    // Fluxer allows 60 webhook messages a minute per webhook
    // (src/history/limits.ts:5-6).
    sendIntervalMs: SEND_INTERVAL_MS,
    maxLinks: 1_000,
};

/** How long start() waits for both clients to be ready. */
export const READY_WAIT_MS = 120_000;
const READY_POLL_MS = 1_000;

export interface RelayCatchUpDeps {
    readonly config: CatchUpConfig;
    readonly store: CatchUpStore;
    /** A message link exists for the message (upstream's LinkService). */
    readonly bridged: (side: Side, messageId: string) => Promise<boolean>;
    readonly listLinks: () => Promise<readonly CatchUpLink[]>;
    readonly commandPrefix: string;
    readonly startedAt: Date;
    readonly logger: AddonLogger;
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly limits?: CatchUpLimits;
    readonly readyWaitMs?: number;
}

export interface CatchUpClients {
    readonly discordClient: DiscordClient;
    readonly fluxerClientRef: { readonly current: FluxerClient | null };
}

export interface RelayCatchUp {
    /** For startDiscordClient and startFluxerClient. */
    readonly hooks: CatchUpHooks;
    readonly gate: RelayGate;
    /** Runs catch-up once. Resolves when it is done; never rejects. */
    start(clients: CatchUpClients): Promise<void>;
}

const realSleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Checks the retry queue first, then message links: the queue drain
 * records the link before it deletes the entry (MessageQueueService
 * drain), so a copy in flight is always seen by one of the two.
 */
export function copyCheck(
    store: CatchUpStore,
    bridged: RelayCatchUpDeps['bridged']
): AlreadyCopied {
    return async (side, messageId) =>
        (await store.isQueued(side, messageId)) ||
        (await bridged(side, messageId)) ||
        (await store.isHistoryCopy(side, messageId));
}

/** Polls `ready` until it holds or `waitMs` passes. */
export async function waitUntil(
    ready: () => boolean,
    waitMs: number,
    sleep: (ms: number) => Promise<void>
): Promise<boolean> {
    const rounds = Math.ceil(waitMs / READY_POLL_MS);
    for (let round = 0; round <= rounds; round++) {
        if (ready()) return true;
        if (round < rounds) await sleep(READY_POLL_MS);
    }
    return false;
}

export function createRelayCatchUp(deps: RelayCatchUpDeps): RelayCatchUp {
    const alreadyCopied = copyCheck(deps.store, deps.bridged);
    // Open from process start, so no live copy races catch-up.
    const gate = new RelayGate(alreadyCopied, deps.logger, deps.config.enabled);
    const hooks = createCatchUpHooks(gate);
    return {
        hooks,
        gate,
        start: (clients) =>
            startCatchUp(deps, { gate, hooks, alreadyCopied }, clients),
    };
}

interface Parts {
    readonly gate: RelayGate;
    readonly hooks: CatchUpHooks;
    readonly alreadyCopied: AlreadyCopied;
}

async function startCatchUp(
    deps: RelayCatchUpDeps,
    parts: Parts,
    clients: CatchUpClients
): Promise<void> {
    const sleep = deps.sleep ?? realSleep;
    try {
        if (!deps.config.enabled) return;
        const ready = () =>
            clients.discordClient.isReady() &&
            clients.fluxerClientRef.current?.isReady() === true &&
            parts.hooks.discord.bound &&
            parts.hooks.fluxer.bound;
        if (
            !(await waitUntil(ready, deps.readyWaitMs ?? READY_WAIT_MS, sleep))
        ) {
            deps.logger.warn(
                '[catch-up] Skipped: Discord and Fluxer were not both ready'
            );
            return;
        }
        await runCatchUp(deps, parts, clients, sleep);
    } catch (error) {
        deps.logger.error('[catch-up] Failed to start', error);
    } finally {
        parts.gate.close();
    }
}

async function runCatchUp(
    deps: RelayCatchUpDeps,
    parts: Parts,
    clients: CatchUpClients,
    sleep: (ms: number) => Promise<void>
): Promise<void> {
    const now = deps.now ?? Date.now;
    const began = now();
    deps.logger.info('[catch-up] Catching up messages missed while down');
    const summary = await new CatchUp({
        ...deps,
        limits: deps.limits ?? CATCH_UP_LIMITS,
        gate: parts.gate,
        alreadyCopied: parts.alreadyCopied,
        discord: discordSource(clients.discordClient, parts.hooks.discord),
        fluxer: fluxerSource(clients.fluxerClientRef, parts.hooks.fluxer),
        now,
        sleep,
    }).run();
    const seconds = Math.round((now() - began) / 1000);
    deps.logger.info(
        `[catch-up] Done in ${seconds}s: ${summary.links} channel links, relayed ${summary.relayed}, already copied ${summary.alreadyCopied}, skipped ${summary.skipped}, failed ${summary.failed}`
    );
    if (summary.unfinished > 0) {
        deps.logger.warn(
            `[catch-up] Time budget ran out; ${summary.unfinished} channel links were not caught up`
        );
    }
}
