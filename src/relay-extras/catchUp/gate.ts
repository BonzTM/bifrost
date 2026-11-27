import type { Message as FluxerMessage } from '@fluxerjs/core';
import type { Message, OmitPartialGroupDMChannel } from 'discord.js';
import type { AddonLogger } from '../../addons/isolation';
import { KeyedQueue } from '../queue';
import type { Side } from '../types';

/**
 * Keeps live copies and catch-up copies of one channel apart.
 *
 * While the gate is open (from process start until catch-up finishes),
 * each live message waits in a per-channel queue, then relays only if no
 * copy of it exists yet. Catch-up takes the same queue for the whole of a
 * channel. So a live message that arrives while its channel catches up
 * relays after it, and one that catch-up already copied is not copied
 * again. A live message that started before catch-up reached its channel
 * has finished, and recorded its message link, before catch-up reads it.
 *
 * Once closed, live messages relay at once, exactly as upstream does.
 */

/** True when a message was copied already, or waits in the retry queue. */
export type AlreadyCopied = (side: Side, messageId: string) => Promise<boolean>;

function queueKey(side: Side, channelId: string): string {
    return `${side}:${channelId}`;
}

export class RelayGate {
    private readonly queue = new KeyedQueue();
    private open: boolean;

    constructor(
        private readonly alreadyCopied: AlreadyCopied,
        private readonly logger: AddonLogger,
        open: boolean
    ) {
        this.open = open;
    }

    get isOpen(): boolean {
        return this.open;
    }

    /** Lets live messages relay at once from now on. */
    close(): void {
        this.open = false;
    }

    /** Relays one live message, behind any catch-up of its channel. */
    live(
        side: Side,
        channelId: string,
        messageId: string,
        relay: () => Promise<void>
    ): Promise<void> {
        if (!this.open) return relay();
        return this.queue.run(queueKey(side, channelId), async () => {
            if (await this.copiedOrUnknown(side, messageId)) return;
            await relay();
        });
    }

    /** Runs `work` with the channel to itself: live messages wait. */
    async exclusive<T>(
        side: Side,
        channelId: string,
        work: () => Promise<T>
    ): Promise<T> {
        const box: { done: boolean; value?: T } = { done: false };
        await this.queue.run(queueKey(side, channelId), async () => {
            box.value = await work();
            box.done = true;
        });
        if (!box.done) throw new Error('Catch-up work did not finish');
        return box.value as T;
    }

    /**
     * A failed check relays anyway: the live relay never checked before
     * the gate existed, and a lost message is worse than a rare second
     * copy.
     */
    private async copiedOrUnknown(
        side: Side,
        messageId: string
    ): Promise<boolean> {
        try {
            return await this.alreadyCopied(side, messageId);
        } catch (error) {
            const detail = error instanceof Error ? error.message : error;
            this.logger.warn(
                `[catch-up] Copy check for live ${side} message ${messageId} failed, relaying: ${detail}`
            );
            return false;
        }
    }
}

/** The relay a side's live handler uses (upstream's MessageRelay). */
export interface RelaySink<M> {
    relayMessage(message: M): Promise<void>;
}

export interface GatedMessage {
    readonly id: string;
    readonly channelId: string;
}

/**
 * One side's relay, shared by its live handler and catch-up. The live
 * handler binds its relay once per client (src/discord.ts, src/fluxer.ts);
 * a restarted Fluxer client binds its new relay in place of the old one.
 */
export class SideRelay<M extends GatedMessage> {
    private sink: RelaySink<M> | null = null;

    constructor(
        private readonly side: Side,
        private readonly gate: RelayGate
    ) {}

    get bound(): boolean {
        return this.sink !== null;
    }

    /** Binds the live relay and returns the live handler's relay call. */
    bind(sink: RelaySink<M>): (message: M) => Promise<void> {
        this.sink = sink;
        return (message) =>
            this.gate.live(this.side, message.channelId, message.id, () =>
                sink.relayMessage(message)
            );
    }

    /** Relays a caught-up message through the bound live relay. */
    async relay(message: M): Promise<void> {
        if (this.sink === null) {
            throw new Error(`No ${this.side} relay is bound for catch-up`);
        }
        await this.sink.relayMessage(message);
    }
}

export type DiscordRelayMessage = OmitPartialGroupDMChannel<Message<boolean>>;

/** What src/discord.ts and src/fluxer.ts take from catch-up. */
export interface CatchUpHooks {
    readonly discord: SideRelay<DiscordRelayMessage>;
    readonly fluxer: SideRelay<FluxerMessage>;
}

export function createCatchUpHooks(gate: RelayGate): CatchUpHooks {
    return {
        discord: new SideRelay<DiscordRelayMessage>('discord', gate),
        fluxer: new SideRelay<FluxerMessage>('fluxer', gate),
    };
}
