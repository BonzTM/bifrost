import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { copyCheck } from '../../src/relay-extras/catchUp';
import { RelayGate } from '../../src/relay-extras/catchUp/gate';
import {
    CatchUp,
    describeReport,
    type CatchUpDeps,
    type CatchUpLink,
} from '../../src/relay-extras/catchUp/runner';
import { snowflakeBefore } from '../../src/relay-extras/catchUp/select';
import { createRecordingLogger } from '../addons/fakes';
import {
    CONFIG,
    fakeClock,
    FakeSource,
    FakeStore,
    HOUR,
    idAt,
    LIMITS,
    makeLink,
    message,
    NOW,
    type FakeMessage,
} from './catch-up-fakes';

const STARTED = new Date(NOW - 60_000);

function setup(links: CatchUpLink[] = [makeLink()]) {
    const store = new FakeStore();
    const bridgedIds = new Set<string>();
    const logger = createRecordingLogger();
    const alreadyCopied = copyCheck(store, async (side, id) =>
        bridgedIds.has(`${side}:${id}`)
    );
    const gate = new RelayGate(alreadyCopied, logger, true);
    const discord = new FakeSource('discord');
    const fluxer = new FakeSource('fluxer');
    const time = fakeClock();
    const deps: CatchUpDeps<FakeMessage, FakeMessage> = {
        config: CONFIG,
        limits: LIMITS,
        gate,
        store,
        alreadyCopied,
        listLinks: async () => links,
        discord,
        fluxer,
        commandPrefix: '!b ',
        startedAt: STARTED,
        logger,
        now: time.now,
        sleep: time.sleep,
    };
    return { deps, store, bridgedIds, logger, gate, discord, fluxer, time };
}

const ids = [1, 2, 3, 4, 5].map((n) => idAt(NOW - 10 * 60_000 + n * 1000));

describe('catch-up run', () => {
    it('relays missed messages both ways, oldest first, paced', async () => {
        const t = setup();
        t.store.bridged.set('cl-1:discord', idAt(NOW - HOUR));
        t.store.bridged.set('cl-1:fluxer', idAt(NOW - HOUR));
        t.discord.pages.set(
            'dc-1',
            [ids[2], ids[0], ids[1]].map((i) => message(i))
        );
        t.fluxer.pages.set('fc-1', [message(ids[3])]);
        const summary = await new CatchUp(t.deps).run();
        assert.deepEqual(t.discord.relayed, [ids[0], ids[1], ids[2]]);
        assert.deepEqual(t.fluxer.relayed, [ids[3]]);
        assert.equal(summary.relayed, 4);
        assert.deepEqual(t.time.clock.slept, [1050, 1050, 1050, 1050]);
        assert.equal(t.gate.isOpen, false, 'the gate closes when done');
    });

    it('reads the last message bridged before the process started', async () => {
        const t = setup();
        const last = idAt(NOW - HOUR);
        t.store.bridged.set('cl-1:discord', last);
        await new CatchUp(t.deps).run();
        assert.equal(t.store.newestCalls[0].before, STARTED);
        assert.equal(t.discord.fetches[0].afterId, last);
        assert.equal(t.discord.fetches[0].limit, 100);
    });

    it('fetches only the last day when nothing was bridged lately', async () => {
        const t = setup();
        await new CatchUp(t.deps).run();
        assert.equal(
            t.fluxer.fetches[0].afterId,
            snowflakeBefore(NOW - 24 * HOUR)
        );
    });

    it('skips own, bridged, command and join messages', async () => {
        const t = setup();
        t.discord.pages.set('dc-1', [
            message(ids[0], { authorId: 'bot' }),
            message(ids[1], { webhookId: 'dw-1' }),
            message(ids[2], { content: '!b help' }),
            message(ids[3], { isJoin: true }),
            message(ids[4]),
        ]);
        const summary = await new CatchUp(t.deps).run();
        assert.deepEqual(t.discord.relayed, [ids[4]]);
        assert.equal(summary.skipped, 4);
    });

    it('never copies a message bridged, queued or imported already', async () => {
        const t = setup();
        t.bridgedIds.add(`discord:${ids[0]}`);
        t.store.queued.add(`discord:${ids[1]}`);
        t.store.copies.add(`discord:${ids[2]}`);
        t.discord.pages.set(
            'dc-1',
            ids.slice(0, 4).map((i) => message(i))
        );
        const summary = await new CatchUp(t.deps).run();
        assert.deepEqual(t.discord.relayed, [ids[3]]);
        assert.equal(summary.alreadyCopied, 3);
    });

    it('flags a full page: newer missed messages stay missed', async () => {
        const t = setup();
        t.deps = { ...t.deps, config: { ...CONFIG, maxMessages: 2 } };
        t.discord.pages.set(
            'dc-1',
            ids.map((i) => message(i))
        );
        await new CatchUp(t.deps).run();
        assert.deepEqual(t.discord.relayed, [ids[0], ids[1]]);
        assert.ok(
            t.logger.entries.some((e) =>
                e.message.includes('message limit reached')
            )
        );
    });

    it('stops at the time budget and reports what is left', async () => {
        const links = [makeLink(), makeLink({ id: 'cl-2', linkId: 'l2' })];
        const t = setup(links);
        t.deps = { ...t.deps, limits: { ...LIMITS, budgetMs: 2_000 } };
        t.discord.pages.set(
            'dc-1',
            ids.map((i) => message(i))
        );
        const summary = await new CatchUp(t.deps).run();
        assert.equal(t.discord.relayed.length, 2);
        assert.equal(summary.unfinished, 1);
        assert.equal(t.gate.isOpen, false);
    });

    it('carries on after a channel fails', async () => {
        const links = [
            makeLink(),
            makeLink({ id: 'cl-2', linkId: 'l2', discordChannelId: 'dc-2' }),
        ];
        const t = setup(links);
        t.discord.pages.set('dc-1', new Error('Missing Access'));
        t.discord.pages.set('dc-2', [message(ids[0])]);
        const summary = await new CatchUp(t.deps).run();
        assert.deepEqual(t.discord.relayed, [ids[0]]);
        assert.equal(summary.links, 2);
        assert.ok(
            t.logger.entries.some(
                (e) =>
                    e.level === 'warn' && e.message.includes('Missing Access')
            )
        );
    });

    it('counts a failed send and goes on to the next message', async () => {
        const t = setup();
        t.discord.pages.set('dc-1', [message(ids[0]), message(ids[1])]);
        t.discord.failRelay.add(ids[0]);
        const summary = await new CatchUp(t.deps).run();
        assert.deepEqual(t.discord.relayed, [ids[1]]);
        assert.equal(summary.failed, 1);
    });

    it('skips a channel the relay does not copy', async () => {
        const t = setup();
        t.discord.pages.set('dc-1', null);
        await new CatchUp(t.deps).run();
        assert.ok(
            t.logger.entries.some((e) =>
                e.message.includes('is not a relayed channel')
            )
        );
    });

    it('refuses a side whose bot user is unknown', async () => {
        const t = setup();
        const blind = new FakeSource('fluxer', null);
        blind.pages.set('fc-1', [message(ids[0])]);
        t.deps = { ...t.deps, fluxer: blind };
        await new CatchUp(t.deps).run();
        assert.deepEqual(blind.relayed, []);
        assert.equal(blind.fetches.length, 0);
    });

    it('closes the gate even when listing links fails', async () => {
        const t = setup();
        t.deps = {
            ...t.deps,
            listLinks: async () => {
                throw new Error('db down');
            },
        };
        await new CatchUp(t.deps).run();
        assert.equal(t.gate.isOpen, false);
        assert.equal(t.logger.entries[0].level, 'error');
    });
});

describe('catch-up and live messages', () => {
    it('copies a message once when its live event arrives mid catch-up', async () => {
        const t = setup();
        const live: Promise<void>[] = [];
        const sent: string[] = [];
        t.discord.onRelay = async (m) => {
            sent.push(`catch-up ${m.id}`);
            // The relay records a message link, as upstream's does.
            t.bridgedIds.add(`discord:${m.id}`);
            if (m.id !== ids[0]) return;
            // ids[1] arrives live while catch-up still holds the channel.
            live.push(
                t.gate.live('discord', 'dc-1', ids[1], async () => {
                    sent.push(`live ${ids[1]}`);
                })
            );
        };
        t.discord.pages.set('dc-1', [message(ids[0]), message(ids[1])]);
        await new CatchUp(t.deps).run();
        await Promise.all(live);
        assert.deepEqual(sent, [`catch-up ${ids[0]}`, `catch-up ${ids[1]}`]);
    });

    it('skips a message the live relay copied before catch-up got there', async () => {
        const t = setup();
        await t.gate.live('discord', 'dc-1', ids[0], async () => {
            t.bridgedIds.add(`discord:${ids[0]}`);
        });
        t.discord.pages.set('dc-1', [message(ids[0])]);
        const summary = await new CatchUp(t.deps).run();
        assert.deepEqual(t.discord.relayed, []);
        assert.equal(summary.alreadyCopied, 1);
    });
});

describe('catch-up report line', () => {
    it('gives counts and reasons, never message text', () => {
        const line = describeReport('discord', 'l1', {
            fetched: 4,
            skipped: {
                'own-bot': 1,
                'bridge-webhook': 0,
                command: 1,
                join: 0,
                'before-gap': 0,
            },
            relayed: 2,
            alreadyCopied: 0,
            failed: 0,
            limited: false,
            stopped: false,
            unavailable: false,
        });
        assert.equal(
            line,
            '[catch-up] Link l1, Discord to Fluxer: relayed 2 of 4 fetched, skipped 2 (own-bot 1, command 1), already copied 0, failed 0'
        );
    });
});
