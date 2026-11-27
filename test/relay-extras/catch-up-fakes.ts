import type { CatchUpConfig } from '../../src/relay-extras/catchUp/config';
import type {
    CatchUpLimits,
    CatchUpLink,
} from '../../src/relay-extras/catchUp/runner';
import type { Candidate } from '../../src/relay-extras/catchUp/select';
import type { CatchUpSource } from '../../src/relay-extras/catchUp/sources';
import type {
    CatchUpStore,
    LinkedChannels,
} from '../../src/relay-extras/catchUp/store';
import type { Side } from '../../src/relay-extras/types';

/** Discord's and Fluxer's snowflake epoch. */
const EPOCH = 1_420_070_400_000;

/** A snowflake made at `ms`, with `seq` in the low bits. */
export function idAt(ms: number, seq = 0): string {
    return ((BigInt(ms - EPOCH) << BigInt(22)) + BigInt(seq)).toString();
}

export const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
export const HOUR = 60 * 60_000;

export const CONFIG: CatchUpConfig = {
    enabled: true,
    maxAgeMs: 24 * HOUR,
    maxMessages: 100,
};

export const LIMITS: CatchUpLimits = {
    budgetMs: 60_000,
    fetchTimeoutMs: 1_000,
    sendIntervalMs: 1_050,
    maxLinks: 10,
};

export function makeLink(overrides: Partial<CatchUpLink> = {}): CatchUpLink {
    return {
        id: 'cl-1',
        linkId: 'l1',
        discordChannelId: 'dc-1',
        fluxerChannelId: 'fc-1',
        discordWebhookId: 'dw-1',
        fluxerWebhookId: 'fw-1',
        createdAt: new Date(NOW - 30 * 24 * HOUR),
        ...overrides,
    };
}

/** A fetched message as the fake sources hand it out. */
export interface FakeMessage extends Candidate {
    readonly channelId: string;
}

export function message(
    id: string,
    overrides: Partial<FakeMessage> = {}
): FakeMessage {
    return {
        id,
        channelId: 'dc-1',
        authorId: 'user-1',
        webhookId: null,
        content: 'hello',
        isJoin: false,
        ...overrides,
    };
}

export class FakeStore implements CatchUpStore {
    readonly bridged = new Map<string, string>();
    readonly history = new Map<string, string>();
    readonly queued = new Set<string>();
    readonly copies = new Set<string>();
    readonly newestCalls: { channelLinkId: string; before: Date }[] = [];

    async newestBridged(channelLinkId: string, side: Side, before: Date) {
        this.newestCalls.push({ channelLinkId, before });
        return this.bridged.get(`${channelLinkId}:${side}`) ?? null;
    }

    async newestHistoryCopy(link: LinkedChannels, side: Side) {
        return this.history.get(`${link.id}:${side}`) ?? null;
    }

    async isQueued(side: Side, messageId: string) {
        return this.queued.has(`${side}:${messageId}`);
    }

    async isHistoryCopy(side: Side, messageId: string) {
        return this.copies.has(`${side}:${messageId}`);
    }
}

/** A source that serves fixed pages and records what it relays. */
export class FakeSource implements CatchUpSource<FakeMessage> {
    readonly relayed: string[] = [];
    readonly fetches: { channelId: string; afterId: string; limit: number }[] =
        [];
    pages = new Map<string, FakeMessage[] | null | Error>();
    failRelay = new Set<string>();
    onRelay: (message: FakeMessage) => Promise<void> = async () => undefined;

    constructor(
        readonly side: Side,
        private readonly bot: string | null = 'bot'
    ) {}

    botUserId() {
        return this.bot;
    }

    async fetchAfter(channelId: string, afterId: string, limit: number) {
        this.fetches.push({ channelId, afterId, limit });
        const page = this.pages.get(channelId);
        if (page instanceof Error) throw page;
        if (page === null) return null;
        return (page ?? []).filter((m) => BigInt(m.id) > BigInt(afterId));
    }

    facts(m: FakeMessage): Candidate {
        return m;
    }

    async relay(m: FakeMessage) {
        if (this.failRelay.has(m.id)) throw new Error('send failed');
        this.relayed.push(m.id);
        await this.onRelay(m);
    }
}

/** A clock tests move by hand, and a sleep that moves it. */
export function fakeClock(start = NOW) {
    const clock = { now: start, slept: [] as number[] };
    return {
        clock,
        now: () => clock.now,
        sleep: async (ms: number) => {
            clock.slept.push(ms);
            clock.now += ms;
        },
    };
}
