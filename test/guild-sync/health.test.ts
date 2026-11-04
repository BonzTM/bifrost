import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkShrink, checkSourceHealth } from '../../src/guild-sync/health';
import { countObjects } from '../../src/guild-sync/snapshot';
import { channel, discordGuild } from './fixtures';

const LIMITS = { shrinkPercent: 10, shrinkMinObjects: 5 };

function withChannels(count: number) {
    return discordGuild({
        channels: Array.from({ length: count }, (_, i) => channel(`c${i}`)),
    });
}

describe('checkSourceHealth (guard 2)', () => {
    it('passes a plausible read', () => {
        assert.equal(
            checkSourceHealth({ ok: true, snapshot: discordGuild() }).ok,
            true
        );
    });

    const failures = [
        ['error', { ok: false, reason: 'error', detail: 'boom' }],
        ['timeout', { ok: false, reason: 'timeout', detail: 'slow' }],
        ['not ready', { ok: false, reason: 'not-ready', detail: 'x' }],
        ['unavailable', { ok: false, reason: 'unavailable', detail: 'x' }],
        [
            'empty source',
            { ok: true, snapshot: discordGuild({ roles: [], channels: [] }) },
        ],
        [
            'partial source without @everyone',
            { ok: true, snapshot: discordGuild({ roles: [] }) },
        ],
        [
            'partial source without channels',
            { ok: true, snapshot: discordGuild({ channels: [] }) },
        ],
        [
            'blank server name',
            { ok: true, snapshot: discordGuild({ name: ' ' }) },
        ],
    ] as const;

    for (const [label, read] of failures) {
        it(`fails on ${label}`, () => {
            assert.equal(checkSourceHealth(read).ok, false);
        });
    }
});

describe('checkShrink (guard 3)', () => {
    it('passes with no earlier snapshot', () => {
        assert.deepEqual(checkShrink(withChannels(1), null, LIMITS), {
            ok: true,
        });
    });

    it('allows the larger of 10% and 5 objects', () => {
        const before = countObjects(withChannels(100));
        assert.equal(checkShrink(withChannels(90), before, LIMITS).ok, true);
        assert.equal(checkShrink(withChannels(89), before, LIMITS).ok, false);
        const small = countObjects(withChannels(8));
        assert.equal(checkShrink(withChannels(3), small, LIMITS).ok, true);
        assert.equal(checkShrink(withChannels(2), small, LIMITS).ok, false);
    });

    it('trips on a 50% drop', () => {
        const before = countObjects(withChannels(40));
        const result = checkShrink(withChannels(20), before, LIMITS);
        assert.equal(result.ok, false);
    });

    it('fails closed on out-of-range limits', () => {
        const bad = { shrinkPercent: 0, shrinkMinObjects: 5 };
        assert.equal(checkShrink(withChannels(1), null, bad).ok, false);
    });
});
