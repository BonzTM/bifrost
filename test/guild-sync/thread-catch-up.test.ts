import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SnapshotSide } from '../../src/addons/db/schema';
import type { ThreadMessage } from '../../src/guild-sync/store';
import {
    oldestFirst,
    ThreadCatchUp,
    type CatchUpThread,
    type FoundMessage,
    type ThreadCatchUpDeps,
    type ThreadCatchUpSource,
} from '../../src/guild-sync/threadCatchUp';
import { snowflakeBefore } from '../../src/relay-extras/catchUp/select';
import { createRecordingLogger } from '../addons/fakes';

const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
/** A snowflake made `hoursAgo` before NOW, plus `n`. */
const at = (hoursAgo: number, n = 0) =>
    (BigInt(snowflakeBefore(NOW - hoursAgo * HOUR)) + BigInt(1 + n)).toString();

const T1 = at(48);
const OLD = at(30);
const LAST = at(5);
const M1 = at(3, 1);
const M2 = at(2, 2);
const M3 = at(1, 3);

class FakeSource implements ThreadCatchUpSource {
    threads: CatchUpThread[] = [];
    pages = new Map<string, FoundMessage[]>();
    asked: { threadId: string; afterId: string }[] = [];
    failList = false;

    constructor(readonly side: SnapshotSide) {}

    async activeThreads(limit: number) {
        if (this.failList) throw new Error('Missing Access');
        return this.threads.slice(0, limit);
    }

    async messagesAfter(thread: CatchUpThread, afterId: string) {
        this.asked.push({ threadId: thread.id, afterId });
        return (this.pages.get(thread.id) ?? []).filter(
            (m) => BigInt(m.event.id) > BigInt(afterId)
        );
    }
}

function found(id: string, threadId = T1, parentId = 'forum'): FoundMessage {
    return {
        event: { id, channelId: threadId, parentId, webhookId: null },
        raw: `raw-${id}`,
    };
}

function setup() {
    const discord = new FakeSource('discord');
    const fluxer = new FakeSource('fluxer');
    const messages: ThreadMessage[] = [];
    const newest = new Map<string, string>();
    const covered = new Set<string>();
    const pairs = new Set<string>();
    const relayed: string[] = [];
    const logger = createRecordingLogger();
    const deps: ThreadCatchUpDeps = {
        config: { enabled: true, maxAgeMs: 24 * HOUR, maxMessages: 100 },
        limits: {
            maxThreads: 10,
            fetchTimeoutMs: 1_000,
            budgetMs: 60_000,
            sendIntervalMs: 0,
        },
        sources: [discord, fluxer],
        store: {
            findThreadPair: async (side, id) =>
                pairs.has(`${side}:${id}`)
                    ? { guildLinkId: 'g', discordId: id, fluxerId: id }
                    : null,
            findThreadMessage: async (side, id) =>
                messages.find(
                    (m) =>
                        (side === 'discord'
                            ? m.discordMessageId
                            : m.fluxerMessageId) === id
                ) ?? null,
            historyCovers: async (threadId, id) =>
                covered.has(`${threadId} ${id}`),
            newestThreadMessage: async (side, id) =>
                newest.get(`${side}:${id}`) ?? null,
        },
        relay: async (from, event) => {
            relayed.push(`${from} ${event.id}`);
        },
        startedAt: new Date(NOW),
        now: () => NOW,
        sleep: async () => {},
        logger,
    };
    return {
        discord,
        fluxer,
        messages,
        newest,
        covered,
        pairs,
        relayed,
        logger,
        deps,
    };
}

const thread = (id = T1, lastMessageId: string | null = null) => ({
    id,
    parentId: 'forum',
    guildId: 'guild',
    lastMessageId,
});

describe('ThreadCatchUp', () => {
    it('relays missed thread messages oldest first, after the last copy', async () => {
        const t = setup();
        t.pairs.add(`discord:${T1}`);
        t.newest.set(`discord:${T1}`, LAST);
        t.discord.threads = [thread()];
        t.discord.pages.set(T1, [found(M3), found(OLD), found(M1), found(M2)]);
        const summary = await new ThreadCatchUp(t.deps).run();
        assert.deepEqual(t.relayed, [
            `discord ${M1}`,
            `discord ${M2}`,
            `discord ${M3}`,
        ]);
        assert.equal(t.discord.asked[0].afterId, LAST);
        assert.equal(summary.relayed, 3);
    });

    it('starts at the age limit when nothing was copied', async () => {
        const t = setup();
        t.discord.threads = [thread()];
        t.discord.pages.set(T1, [found(OLD), found(M1)]);
        await new ThreadCatchUp(t.deps).run();
        assert.deepEqual(t.relayed, [`discord ${M1}`]);
        assert.equal(
            t.discord.asked[0].afterId,
            snowflakeBefore(NOW - 24 * HOUR)
        );
    });

    it('reads no messages for a thread with nothing new', async () => {
        const t = setup();
        t.newest.set(`discord:${T1}`, LAST);
        t.discord.threads = [thread(T1, LAST)];
        await new ThreadCatchUp(t.deps).run();
        assert.deepEqual(t.discord.asked, []);
    });

    it('skips copied messages, history copies and Discord starters', async () => {
        const t = setup();
        const post = at(4);
        t.pairs.add(`discord:${post}`);
        t.discord.threads = [thread(post)];
        t.discord.pages.set(post, [
            found(post, post),
            found(M1, post),
            found(M2, post),
            found(M3, post),
        ]);
        t.messages.push({
            guildLinkId: 'g',
            discordThreadId: post,
            fluxerThreadId: 'f',
            discordMessageId: M1,
            fluxerMessageId: 'c1',
        });
        t.covered.add(`${post} ${M2}`);
        const summary = await new ThreadCatchUp(t.deps).run();
        assert.deepEqual(t.relayed, [`discord ${M3}`]);
        assert.equal(summary.skipped, 3);
    });

    it('passes the starter of an unpaired Fluxer post, so it is mirrored', async () => {
        const t = setup();
        const post = at(4);
        t.fluxer.threads = [thread(post)];
        t.fluxer.pages.set(post, [found(M1, post), found(post, post)]);
        await new ThreadCatchUp(t.deps).run();
        assert.deepEqual(t.relayed, [`fluxer ${post}`, `fluxer ${M1}`]);
    });

    it('skips the starter of a paired Fluxer post', async () => {
        const t = setup();
        const post = at(4);
        t.pairs.add(`fluxer:${post}`);
        t.fluxer.threads = [thread(post)];
        t.fluxer.pages.set(post, [found(post, post), found(M1, post)]);
        await new ThreadCatchUp(t.deps).run();
        assert.deepEqual(t.relayed, [`fluxer ${M1}`]);
    });

    it('keeps going on the other side when one side cannot list threads', async () => {
        const t = setup();
        t.discord.failList = true;
        t.fluxer.threads = [thread()];
        t.fluxer.pages.set(T1, [found(M1)]);
        await new ThreadCatchUp(t.deps).run();
        assert.deepEqual(t.relayed, [`fluxer ${M1}`]);
        assert.ok(
            t.logger.entries.some(
                (e) =>
                    e.level === 'warn' && e.message.includes('Missing Access')
            )
        );
    });

    it('counts a failed relay and moves on', async () => {
        const t = setup();
        t.discord.threads = [thread()];
        t.discord.pages.set(T1, [found(M1), found(M2)]);
        const relay = t.deps.relay;
        t.deps = {
            ...t.deps,
            relay: async (from, event, raw) => {
                if (event.id === M1) throw new Error('503');
                await relay(from, event, raw);
            },
        };
        const summary = await new ThreadCatchUp(t.deps).run();
        assert.deepEqual(t.relayed, [`discord ${M2}`]);
        assert.equal(summary.failed, 1);
    });

    it('stops at the time budget and counts the threads left', async () => {
        const t = setup();
        let now = NOW;
        t.deps = { ...t.deps, now: () => now };
        t.discord.threads = [thread(at(10)), thread(at(9))];
        t.discord.pages.set(at(10), [found(M1, at(10))]);
        t.deps = {
            ...t.deps,
            relay: async () => {
                now += 120_000;
            },
        };
        const summary = await new ThreadCatchUp(t.deps).run();
        assert.equal(summary.unfinished, 1);
    });
});

describe('oldestFirst', () => {
    it('orders by snowflake, not by text', () => {
        const ids = oldestFirst([found('100'), found('99'), found('1000')]);
        assert.deepEqual(
            ids.map((m) => m.event.id),
            ['99', '100', '1000']
        );
    });
});
