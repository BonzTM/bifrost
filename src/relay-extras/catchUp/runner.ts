import { withTimeout } from '../../addons/host';
import type { AddonLogger } from '../../addons/isolation';
import type { Side } from '../types';
import type { CatchUpConfig } from './config';
import type { AlreadyCopied, RelayGate } from './gate';
import {
    emptySkipCounts,
    gapStart,
    selectMissed,
    SKIP_VERDICTS,
    type Candidate,
    type SkipContext,
    type SkipCounts,
} from './select';
import type { CatchUpSource } from './sources';
import type { CatchUpStore } from './store';

/**
 * Copies the messages each bridged channel missed while bifrost was down,
 * one channel and direction at a time, oldest first, through the live
 * relay (docs/design/relay-catch-up.md).
 */

/** The channel link fields catch-up reads (upstream's ChannelLink). */
export interface CatchUpLink {
    readonly id: string;
    readonly linkId: string;
    readonly discordChannelId: string;
    readonly fluxerChannelId: string;
    readonly discordWebhookId: string;
    readonly fluxerWebhookId: string;
    readonly createdAt: Date | string;
}

export interface CatchUpLimits {
    /** The whole run stops starting new work after this long. */
    readonly budgetMs: number;
    /** Bound on one message list request. */
    readonly fetchTimeoutMs: number;
    /** Wait after each copy, so a webhook stays under its rate limit. */
    readonly sendIntervalMs: number;
    /** Bound on the channel links one run reads. */
    readonly maxLinks: number;
}

export interface CatchUpDeps<D, F> {
    readonly config: CatchUpConfig;
    readonly limits: CatchUpLimits;
    readonly gate: RelayGate;
    readonly store: CatchUpStore;
    readonly alreadyCopied: AlreadyCopied;
    readonly listLinks: () => Promise<readonly CatchUpLink[]>;
    readonly discord: CatchUpSource<D>;
    readonly fluxer: CatchUpSource<F>;
    readonly commandPrefix: string;
    /** Process start: links bridged later are the live relay's work. */
    readonly startedAt: Date;
    readonly logger: AddonLogger;
    readonly now: () => number;
    readonly sleep: (ms: number) => Promise<void>;
}

/** What one direction of one channel link did. */
export interface SideReport {
    readonly fetched: number;
    readonly skipped: SkipCounts;
    relayed: number;
    alreadyCopied: number;
    failed: number;
    /** The page was full: newer missed messages, if any, stay missed. */
    readonly limited: boolean;
    /** The time budget ran out inside this channel. */
    stopped: boolean;
    /** The channel is not one the relay copies, or could not be read. */
    readonly unavailable: boolean;
}

export interface CatchUpSummary {
    links: number;
    relayed: number;
    alreadyCopied: number;
    failed: number;
    skipped: number;
    /** Channel links left out when the time budget ran out. */
    unfinished: number;
}

const ARROW: Record<Side, string> = {
    discord: 'Discord to Fluxer',
    fluxer: 'Fluxer to Discord',
};

function report(fetched: number, extra: Partial<SideReport>): SideReport {
    return {
        fetched,
        skipped: emptySkipCounts(),
        relayed: 0,
        alreadyCopied: 0,
        failed: 0,
        limited: false,
        stopped: false,
        unavailable: false,
        ...extra,
    };
}

function totalSkipped(skipped: SkipCounts): number {
    return SKIP_VERDICTS.reduce((sum, verdict) => sum + skipped[verdict], 0);
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** One log line per channel and direction, with counts and no text. */
export function describeReport(side: Side, linkId: string, r: SideReport) {
    const reasons = SKIP_VERDICTS.filter((v) => r.skipped[v] > 0)
        .map((v) => `${v} ${r.skipped[v]}`)
        .join(', ');
    const parts = [
        `relayed ${r.relayed} of ${r.fetched} fetched`,
        `skipped ${totalSkipped(r.skipped)}${reasons ? ` (${reasons})` : ''}`,
        `already copied ${r.alreadyCopied}`,
        `failed ${r.failed}`,
    ];
    if (r.limited) parts.push('message limit reached, newer ones stay missed');
    if (r.stopped) parts.push('time budget ran out');
    return `[catch-up] Link ${linkId}, ${ARROW[side]}: ${parts.join(', ')}`;
}

export class CatchUp<D, F> {
    constructor(private readonly deps: CatchUpDeps<D, F>) {}

    /** Catches up every channel link once. Never throws. */
    async run(): Promise<CatchUpSummary> {
        const summary: CatchUpSummary = {
            links: 0,
            relayed: 0,
            alreadyCopied: 0,
            failed: 0,
            skipped: 0,
            unfinished: 0,
        };
        const deadline = this.deps.now() + this.deps.limits.budgetMs;
        try {
            await this.runLinks(summary, deadline);
        } catch (error) {
            this.deps.logger.error(
                `[catch-up] Stopped: ${errorText(error)}`,
                error
            );
        } finally {
            this.deps.gate.close();
        }
        return summary;
    }

    private async runLinks(summary: CatchUpSummary, deadline: number) {
        const all = await this.deps.listLinks();
        const links = all.slice(0, this.deps.limits.maxLinks);
        if (all.length > links.length) {
            this.deps.logger.warn(
                `[catch-up] ${all.length} channel links; only the first ${links.length} are caught up`
            );
        }
        for (const [index, link] of links.entries()) {
            if (this.deps.now() >= deadline) {
                summary.unfinished = links.length - index;
                break;
            }
            summary.links += 1;
            this.add(
                summary,
                await this.side(this.deps.discord, link, deadline)
            );
            this.add(
                summary,
                await this.side(this.deps.fluxer, link, deadline)
            );
        }
    }

    private add(summary: CatchUpSummary, r: SideReport | null): void {
        if (!r) return;
        summary.relayed += r.relayed;
        summary.alreadyCopied += r.alreadyCopied;
        summary.failed += r.failed;
        summary.skipped += totalSkipped(r.skipped);
    }

    /** One direction of one link. Errors are logged, never thrown. */
    private async side<M>(
        source: CatchUpSource<M>,
        link: CatchUpLink,
        deadline: number
    ): Promise<SideReport | null> {
        const channelId = channelOf(link, source.side);
        try {
            const r = await this.deps.gate.exclusive(
                source.side,
                channelId,
                () => this.copyGap(source, link, channelId, deadline)
            );
            this.log(source.side, link, channelId, r);
            return r;
        } catch (error) {
            this.deps.logger.warn(
                `[catch-up] Link ${link.linkId}, ${ARROW[source.side]}: ${errorText(error)}`
            );
            return null;
        }
    }

    private log(
        side: Side,
        link: CatchUpLink,
        channelId: string,
        r: SideReport
    ) {
        // A forum link: its posts are threads, which guild-sync's thread
        // catch-up covers (src/guild-sync/threadCatchUp.ts).
        if (r.unavailable) {
            this.deps.logger.info(
                `[catch-up] Link ${link.linkId}: ${side} channel ${channelId} has no channel messages to catch up (forum or thread-only); skipped`
            );
            return;
        }
        if (r.fetched > 0)
            this.deps.logger.info(describeReport(side, link.linkId, r));
    }

    /** Where this side's gap starts (select.ts gapStart). */
    private async gapStartFor(link: CatchUpLink, side: Side): Promise<string> {
        const { store, startedAt, config } = this.deps;
        const [bridged, history] = await Promise.all([
            store.newestBridged(link.id, side, startedAt),
            store.newestHistoryCopy(link, side),
        ]);
        return gapStart({
            bridged,
            history,
            linkedAt: new Date(link.createdAt).getTime(),
            oldestAllowed: this.deps.now() - config.maxAgeMs,
        });
    }

    private async copyGap<M>(
        source: CatchUpSource<M>,
        link: CatchUpLink,
        channelId: string,
        deadline: number
    ): Promise<SideReport> {
        const { config, limits } = this.deps;
        const afterId = await this.gapStartFor(link, source.side);
        const ctx = this.skipContext(source, link, afterId);
        const page = await withTimeout(
            source.fetchAfter(channelId, afterId, config.maxMessages),
            limits.fetchTimeoutMs,
            `[catch-up] ${source.side} channel ${channelId} message list`
        );
        if (page === null) return report(0, { unavailable: true });
        const picked = selectMissed(
            page.map((message) => ({ ...source.facts(message), message })),
            ctx,
            config.maxMessages
        );
        const r = report(page.length, {
            skipped: picked.skipped,
            limited: page.length >= config.maxMessages,
        });
        for (const pick of picked.relay) {
            if (this.deps.now() >= deadline) {
                r.stopped = true;
                break;
            }
            await this.copyOne(source, pick, r);
        }
        return r;
    }

    /** Without the bot's own ID the loop guard cannot hold: refuse. */
    private skipContext<M>(
        source: CatchUpSource<M>,
        link: CatchUpLink,
        afterId: string
    ): SkipContext {
        const botUserId = source.botUserId();
        if (botUserId === null) {
            throw new Error(`The ${source.side} bot user is not known yet`);
        }
        return {
            side: source.side,
            botUserId,
            bridgeWebhookId:
                source.side === 'discord'
                    ? link.discordWebhookId
                    : link.fluxerWebhookId,
            commandPrefix: this.deps.commandPrefix,
            afterId,
        };
    }

    /**
     * Relays one missed message unless a copy exists or is queued. A
     * failed check skips the message: a second copy is what catch-up
     * must never make.
     */
    private async copyOne<M>(
        source: CatchUpSource<M>,
        pick: Candidate & { readonly message: M },
        r: SideReport
    ): Promise<void> {
        try {
            if (await this.deps.alreadyCopied(source.side, pick.id)) {
                r.alreadyCopied += 1;
                return;
            }
            await source.relay(pick.message);
            r.relayed += 1;
        } catch (error) {
            r.failed += 1;
            this.deps.logger.warn(
                `[catch-up] ${source.side} message ${pick.id}: ${errorText(error)}`
            );
        }
        await this.deps.sleep(this.deps.limits.sendIntervalMs);
    }
}

function channelOf(link: CatchUpLink, side: Side): string {
    return side === 'discord' ? link.discordChannelId : link.fluxerChannelId;
}
