import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    classify,
    gapStart,
    newestId,
    selectMissed,
    snowflakeBefore,
    type SkipContext,
} from '../../src/relay-extras/catchUp/select';
import { HOUR, idAt, message, NOW } from './catch-up-fakes';

const CTX: SkipContext = {
    side: 'discord',
    botUserId: 'bot',
    bridgeWebhookId: 'dw-1',
    commandPrefix: '!b ',
    afterId: '0',
};

describe('catch-up gap start', () => {
    it('keeps messages made at the cursor time and after', () => {
        const at = NOW - HOUR;
        const cursor = snowflakeBefore(at);
        assert.ok(BigInt(idAt(at)) > BigInt(cursor));
        assert.ok(BigInt(idAt(at - 1, 4_194_303)) <= BigInt(cursor));
        assert.equal(snowflakeBefore(0), '0');
        assert.equal(snowflakeBefore(Number.NaN), '0');
    });

    it('picks the newest snowflake and ignores junk', () => {
        assert.equal(newestId([null, 'x', '9', '10']), '10');
        assert.equal(newestId([]), '0');
    });

    it('starts after the last message bridged before the downtime', () => {
        const bridged = idAt(NOW - 2 * HOUR);
        const start = gapStart({
            bridged,
            history: null,
            linkedAt: NOW - 100 * HOUR,
            oldestAllowed: NOW - 24 * HOUR,
        });
        assert.equal(start, bridged);
    });

    it('never reaches back past the age limit', () => {
        const start = gapStart({
            bridged: idAt(NOW - 72 * HOUR),
            history: null,
            linkedAt: NOW - 100 * HOUR,
            oldestAllowed: NOW - 24 * HOUR,
        });
        assert.equal(start, snowflakeBefore(NOW - 24 * HOUR));
    });

    it('never reaches back past the link: older messages are history', () => {
        const start = gapStart({
            bridged: null,
            history: idAt(NOW - 10 * HOUR),
            linkedAt: NOW - 5 * HOUR,
            oldestAllowed: NOW - 24 * HOUR,
        });
        assert.equal(start, snowflakeBefore(NOW - 5 * HOUR));
    });

    it('starts after a history copy newer than every bound', () => {
        const history = idAt(NOW - HOUR);
        const start = gapStart({
            bridged: idAt(NOW - 3 * HOUR),
            history,
            linkedAt: NOW - 5 * HOUR,
            oldestAllowed: NOW - 24 * HOUR,
        });
        assert.equal(start, history);
    });
});

describe('catch-up skip rules', () => {
    const id = idAt(NOW);

    it('relays a plain message from a person', () => {
        assert.equal(classify(message(id), CTX), 'relay');
    });

    it('skips what the live relay skips', () => {
        assert.equal(
            classify(message(id, { authorId: 'bot' }), CTX),
            'own-bot'
        );
        assert.equal(
            classify(message(id, { webhookId: 'dw-1' }), CTX),
            'bridge-webhook'
        );
        assert.equal(
            classify(message(id, { content: '!b list' }), CTX),
            'command'
        );
    });

    it('relays other webhooks and bots, as the live relay does', () => {
        assert.equal(
            classify(message(id, { webhookId: 'other-hook' }), CTX),
            'relay'
        );
        assert.equal(
            classify(message(id, { authorId: 'other-bot' }), CTX),
            'relay'
        );
    });

    it('skips join notices, which keep no message link', () => {
        assert.equal(classify(message(id, { isJoin: true }), CTX), 'join');
    });

    it('skips anything at or before the gap start', () => {
        const ctx = { ...CTX, afterId: id };
        assert.equal(classify(message(id), ctx), 'before-gap');
        assert.equal(classify(message('not-an-id'), CTX), 'before-gap');
    });
});

describe('catch-up selection', () => {
    const ids = [1, 2, 3, 4].map((n) => idAt(NOW - HOUR + n * 1000));

    it('orders missed messages oldest first', () => {
        const page = [ids[2], ids[0], ids[3], ids[1]].map((i) => message(i));
        const picked = selectMissed(page, CTX, 10);
        assert.deepEqual(
            picked.relay.map((m) => m.id),
            ids
        );
    });

    it('keeps at most the limit, the oldest ones', () => {
        const page = ids.map((i) => message(i)).reverse();
        const picked = selectMissed(page, CTX, 2);
        assert.deepEqual(
            picked.relay.map((m) => m.id),
            ids.slice(0, 2)
        );
    });

    it('counts each skipped message once, by reason', () => {
        const page = [
            message(ids[0], { authorId: 'bot' }),
            message(ids[1], { webhookId: 'dw-1' }),
            message(ids[1], { webhookId: 'dw-1' }),
            message(ids[2], { content: '!b help' }),
            message(ids[3]),
        ];
        const picked = selectMissed(page, CTX, 10);
        assert.deepEqual(
            picked.relay.map((m) => m.id),
            [ids[3]]
        );
        assert.equal(picked.skipped['own-bot'], 1);
        assert.equal(picked.skipped['bridge-webhook'], 1);
        assert.equal(picked.skipped.command, 1);
    });
});
