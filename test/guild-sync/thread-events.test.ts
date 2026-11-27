import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import {
    Events as FluxerEvents,
    ThreadChannel,
    type Client as FluxerClient,
} from '@fluxerjs/core';
import { Events, MessageType, type Client } from 'discord.js';
import {
    FLUXER_FALLBACK_WATCH_MS,
    followFluxerClient,
    listenToDiscordThreads,
    listenToFluxerThreadSettings,
    listenToFluxerThreads,
} from '../../src/guild-sync/threadEvents';
import type { ThreadRelay } from '../../src/guild-sync/threadRelay';

type Wrap = Parameters<typeof listenToDiscordThreads>[2];

/** Records relay calls. The wrap keeps each handler's promise to await. */
function fakeRelay() {
    const calls: string[] = [];
    const record =
        (kind: string) =>
        async (side: string, event: { id: string } | string) => {
            const id = typeof event === 'string' ? event : event.id;
            calls.push(`${kind} ${side} ${id}`);
        };
    const relay = {
        created: record('created'),
        edited: record('edited'),
        deleted: record('deleted'),
        startFlushing: () => calls.push('start'),
        stopFlushing: () => calls.push('stop'),
    } as unknown as ThreadRelay;
    const pending: Promise<void>[] = [];
    const wrap: Wrap = (_task, fn) => {
        return (...args) => {
            pending.push(Promise.resolve(fn(...args)));
        };
    };
    return { calls, relay, wrap, flush: () => Promise.all(pending) };
}

export function discordThreadMessage(
    id: string,
    content: string,
    over: Record<string, unknown> = {}
) {
    return {
        id,
        content,
        channelId: 'd-thread',
        channel: { isThread: () => true, parentId: 'd-parent' },
        webhookId: null,
        type: MessageType.Default,
        author: { id: 'user' },
        partial: false,
        editedTimestamp: null,
        ...over,
    };
}

export function fluxerThreadMessage(
    id: string,
    content: string,
    over: Record<string, unknown> = {}
) {
    const channel = Object.create(ThreadChannel.prototype, {
        parentId: { value: 'f-parent' },
    });
    return {
        id,
        content,
        channelId: 'f-thread',
        channel,
        webhookId: null,
        type: 0,
        author: { id: 'user' },
        partial: false,
        editedAt: null,
        ...over,
    };
}

function discordClient() {
    return Object.assign(new EventEmitter(), { user: { id: 'bot' } });
}

describe('thread relay events', () => {
    it('does not relay Discord thread commands', async () => {
        const { calls, relay, wrap, flush } = fakeRelay();
        const client = discordClient();
        listenToDiscordThreads(client as unknown as Client, relay, wrap, '!b ');
        client.emit(Events.MessageCreate, discordThreadMessage('1', '!b link'));
        client.emit(Events.MessageCreate, discordThreadMessage('2', 'hi !b'));
        await flush();
        assert.deepEqual(calls, ['start', 'created discord 2']);
    });

    it('relays Discord edits but not pin or preview updates', async () => {
        const { calls, relay, wrap, flush } = fakeRelay();
        const client = discordClient();
        const stop = listenToDiscordThreads(
            client as unknown as Client,
            relay,
            wrap,
            '!b '
        );
        const old = discordThreadMessage('1', 'hi');
        // Pinning changes neither the text nor the edited time.
        client.emit(Events.MessageUpdate, old, { ...old, pinned: true });
        const edited = { ...old, content: 'hey', editedTimestamp: Date.now() };
        client.emit(Events.MessageUpdate, old, edited);
        await flush();
        stop();
        assert.deepEqual(calls, ['start', 'edited discord 1', 'stop']);
    });

    it('relays Fluxer edits but not pin updates', async () => {
        const { calls, relay, wrap, flush } = fakeRelay();
        const client = discordClient();
        listenToFluxerThreads(
            client as unknown as FluxerClient,
            relay,
            wrap,
            '!b '
        );
        const old = fluxerThreadMessage('1', 'hi');
        client.emit(FluxerEvents.MessageUpdate, old, { ...old, pinned: true });
        client.emit(FluxerEvents.MessageUpdate, old, {
            ...old,
            content: 'hey',
            editedAt: new Date(),
        });
        await flush();
        assert.deepEqual(calls, ['edited fluxer 1']);
    });

    it('does not relay Fluxer thread commands', async () => {
        const { calls, relay, wrap, flush } = fakeRelay();
        const client = discordClient();
        listenToFluxerThreads(
            client as unknown as FluxerClient,
            relay,
            wrap,
            '!b '
        );
        client.emit(
            FluxerEvents.MessageCreate,
            fluxerThreadMessage('1', '!b help')
        );
        client.emit(FluxerEvents.MessageCreate, fluxerThreadMessage('2', 'ok'));
        await flush();
        assert.deepEqual(calls, ['created fluxer 2']);
    });
});

describe('followFluxerClient', () => {
    const client = (name: string) => ({ name }) as unknown as FluxerClient;

    function follow(ref: { current: FluxerClient | null }) {
        const log: string[] = [];
        const stop = followFluxerClient(ref, (c) => {
            const name = (c as unknown as { name: string }).name;
            log.push(`attach ${name}`);
            return () => log.push(`detach ${name}`);
        });
        return { log, stop };
    }

    it('re-attaches as soon as upstream assigns a new client', () => {
        const ref: { current: FluxerClient | null } = { current: null };
        const { log, stop } = follow(ref);
        ref.current = client('a');
        ref.current = client('b');
        assert.equal((ref.current as unknown as { name: string }).name, 'b');
        stop();
        ref.current = client('c');
        assert.deepEqual(log, ['attach a', 'detach a', 'attach b', 'detach b']);
    });

    it('lets two followers share one ref', () => {
        const ref: { current: FluxerClient | null } = { current: client('a') };
        const first = follow(ref);
        const second = follow(ref);
        ref.current = client('b');
        assert.deepEqual(first.log, ['attach a', 'detach a', 'attach b']);
        assert.deepEqual(second.log, ['attach a', 'detach a', 'attach b']);
        first.stop();
        second.stop();
    });

    it('never throws into the code that assigns the ref', () => {
        const ref: { current: FluxerClient | null } = { current: null };
        let fail = true;
        const stop = followFluxerClient(ref, () => {
            if (fail) throw new Error('attach failed');
            return () => undefined;
        });
        assert.doesNotThrow(() => {
            ref.current = client('a');
        });
        fail = false;
        stop();
    });

    it('polls quickly when the ref cannot be observed', (t) => {
        t.mock.timers.enable({ apis: ['setInterval'] });
        let value: FluxerClient | null = null;
        // A getter-only ref cannot be wrapped with a setter.
        const ref = {
            get current() {
                return value;
            },
        };
        const log: string[] = [];
        const stop = followFluxerClient(ref, () => {
            log.push('attach');
            return () => log.push('detach');
        });
        value = client('a');
        t.mock.timers.tick(FLUXER_FALLBACK_WATCH_MS);
        assert.deepEqual(log, ['attach']);
        stop();
    });
});

describe('Fluxer thread settings events', () => {
    /** A Fluxer thread as the library caches it. */
    function fluxerThread(id: string, over: Record<string, unknown> = {}) {
        const fields = {
            id,
            parentId: 'f-forum',
            name: 'Patch notes',
            archived: false,
            locked: false,
            appliedTags: ['t1'],
            flags: 0,
            rateLimitPerUser: 0,
            autoArchiveDuration: 1440,
            ...over,
        };
        const descriptors = Object.fromEntries(
            Object.entries(fields).map(([k, value]) => [k, { value }])
        );
        return Object.create(ThreadChannel.prototype, descriptors) as object;
    }

    function listen() {
        const { wrap, flush } = fakeRelay();
        const client = new EventEmitter();
        const notified: string[] = [];
        const synced = new Set(['f-post']);
        const stop = listenToFluxerThreadSettings(
            client as unknown as FluxerClient,
            async (id) => synced.has(id),
            () => notified.push('notify'),
            wrap
        );
        const update = (old: object, next: object) =>
            client.emit(FluxerEvents.ThreadUpdate, old, next);
        return { client, notified, flush, stop, update };
    }

    it('schedules a cycle when a synced thread’s settings change', async () => {
        const l = listen();
        l.update(
            fluxerThread('f-post'),
            fluxerThread('f-post', { archived: true })
        );
        await l.flush();
        assert.deepEqual(l.notified, ['notify']);
    });

    it('ignores threads the sync does not hold and other channels', async () => {
        const l = listen();
        l.update(
            fluxerThread('f-other'),
            fluxerThread('f-other', { name: 'Renamed' })
        );
        l.update({ id: 'f-post' }, { id: 'f-post', name: 'Renamed' });
        await l.flush();
        assert.deepEqual(l.notified, []);
    });

    it('ignores updates that change no synced setting', async () => {
        const l = listen();
        l.update(
            fluxerThread('f-post'),
            fluxerThread('f-post', { lastMessageId: '5' })
        );
        await l.flush();
        assert.deepEqual(l.notified, []);
    });

    it('counts an update without a cached copy to compare', async () => {
        const l = listen();
        const thread = fluxerThread('f-post');
        l.update(thread, thread);
        await l.flush();
        assert.deepEqual(l.notified, ['notify']);
    });

    it('stops listening', async () => {
        const l = listen();
        l.stop();
        assert.equal(l.client.listenerCount(FluxerEvents.ThreadUpdate), 0);
    });
});
