import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    createCatchUpHooks,
    RelayGate,
    SideRelay,
    type AlreadyCopied,
} from '../../src/relay-extras/catchUp/gate';
import { createRecordingLogger } from '../addons/fakes';

function gate(open: boolean, copied: AlreadyCopied = async () => false) {
    return new RelayGate(copied, createRecordingLogger(), open);
}

/** A promise and the function that settles it. */
function deferred() {
    let release: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, release };
}

describe('catch-up gate', () => {
    it('relays live messages at once while closed', async () => {
        let checks = 0;
        const g = gate(false, async () => {
            checks += 1;
            return true;
        });
        const sent: string[] = [];
        await g.live('discord', 'c', 'm1', async () => {
            sent.push('m1');
        });
        assert.deepEqual(sent, ['m1']);
        assert.equal(checks, 0, 'a closed gate adds no lookups');
    });

    it('holds live messages behind a catch-up of their channel', async () => {
        const g = gate(true);
        const order: string[] = [];
        const hold = deferred();
        const catchUp = g.exclusive('discord', 'c', async () => {
            await hold.promise;
            order.push('catch-up');
            return 3;
        });
        const live = g.live('discord', 'c', 'm1', async () => {
            order.push('live');
        });
        const other = g.live('discord', 'other', 'm2', async () => {
            order.push('other channel');
        });
        await other;
        hold.release();
        assert.equal(await catchUp, 3);
        await live;
        assert.deepEqual(order, ['other channel', 'catch-up', 'live']);
    });

    it('drops a live message catch-up already copied', async () => {
        const copied = new Set<string>();
        const g = gate(true, async (side, id) => copied.has(`${side}:${id}`));
        const sent: string[] = [];
        await g.exclusive('fluxer', 'c', async () => {
            sent.push('catch-up m1');
            copied.add('fluxer:m1');
        });
        await g.live('fluxer', 'c', 'm1', async () => {
            sent.push('live m1');
        });
        assert.deepEqual(sent, ['catch-up m1']);
    });

    it('relays a live message when the copy check fails', async () => {
        const logger = createRecordingLogger();
        const g = new RelayGate(
            async () => {
                throw new Error('db down');
            },
            logger,
            true
        );
        const sent: string[] = [];
        await g.live('discord', 'c', 'm1', async () => {
            sent.push('m1');
        });
        assert.deepEqual(sent, ['m1']);
        assert.match(logger.entries[0].message, /m1 failed, relaying: db down/);
    });

    it('passes a failed catch-up on to its caller', async () => {
        const g = gate(true);
        await assert.rejects(
            g.exclusive('discord', 'c', async () => {
                throw new Error('boom');
            }),
            /boom/
        );
        const sent: string[] = [];
        await g.live('discord', 'c', 'm1', async () => {
            sent.push('m1');
        });
        assert.deepEqual(sent, ['m1'], 'the channel is not left blocked');
    });
});

describe('catch-up side relay', () => {
    it('sends live and caught-up messages through the bound relay', async () => {
        const hooks = createCatchUpHooks(gate(true));
        const sent: string[] = [];
        const sink = {
            relayMessage: async (m: { id: string; channelId: string }) => {
                sent.push(m.id);
            },
        };
        const side = hooks.discord as unknown as SideRelay<{
            id: string;
            channelId: string;
        }>;
        const live = side.bind(sink);
        await live({ id: 'live', channelId: 'c' });
        await side.relay({ id: 'caught-up', channelId: 'c' });
        assert.deepEqual(sent, ['live', 'caught-up']);
        assert.equal(side.bound, true);
    });

    it('refuses catch-up before a relay is bound', async () => {
        const side = new SideRelay<{ id: string; channelId: string }>(
            'fluxer',
            gate(true)
        );
        assert.equal(side.bound, false);
        await assert.rejects(
            side.relay({ id: 'm', channelId: 'c' }),
            /No fluxer relay is bound/
        );
    });

    it('uses the newest binding after a client restart', async () => {
        const side = new SideRelay<{ id: string; channelId: string }>(
            'fluxer',
            gate(false)
        );
        const sent: string[] = [];
        side.bind({ relayMessage: async () => void sent.push('old') });
        side.bind({ relayMessage: async () => void sent.push('new') });
        await side.relay({ id: 'm', channelId: 'c' });
        assert.deepEqual(sent, ['new']);
    });
});
