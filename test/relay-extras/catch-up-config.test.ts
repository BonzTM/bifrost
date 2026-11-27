import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    CatchUpConfigError,
    parseCatchUpConfig,
    requireCatchUpConfig,
} from '../../src/relay-extras/catchUp/config';

const HOUR = 60 * 60_000;

describe('relay catch-up settings', () => {
    it('is on by default: 24 hours, 100 messages', () => {
        assert.deepEqual(requireCatchUpConfig({}), {
            enabled: true,
            maxAgeMs: 24 * HOUR,
            maxMessages: 100,
        });
    });

    it('reads the switch and both limits', () => {
        const config = requireCatchUpConfig({
            BF_RELAY_CATCH_UP: 'yes',
            BF_RELAY_CATCH_UP_MAX_AGE_HOURS: '6',
            BF_RELAY_CATCH_UP_MAX_MESSAGES: '25',
        });
        assert.deepEqual(config, {
            enabled: true,
            maxAgeMs: 6 * HOUR,
            maxMessages: 25,
        });
    });

    it('accepts the bounds: 1 to 168 hours, 1 to 100 messages', () => {
        for (const [hours, messages] of [
            ['1', '1'],
            ['168', '100'],
        ]) {
            const result = parseCatchUpConfig({
                BF_RELAY_CATCH_UP_MAX_AGE_HOURS: hours,
                BF_RELAY_CATCH_UP_MAX_MESSAGES: messages,
            });
            assert.equal(result.ok, true);
        }
    });

    it('refuses limits out of bounds or not whole numbers', () => {
        for (const bad of ['0', '169', '1.5', '-1', 'abc']) {
            const result = parseCatchUpConfig({
                BF_RELAY_CATCH_UP_MAX_AGE_HOURS: bad,
            });
            assert.equal(result.ok, false, bad);
        }
        for (const bad of ['0', '101', 'ten']) {
            const result = parseCatchUpConfig({
                BF_RELAY_CATCH_UP_MAX_MESSAGES: bad,
            });
            assert.equal(result.ok, false, bad);
        }
    });

    it('refuses a bad switch, and throws at startup', () => {
        assert.equal(
            parseCatchUpConfig({ BF_RELAY_CATCH_UP: 'maybe' }).ok,
            false
        );
        assert.throws(
            () => requireCatchUpConfig({ BF_RELAY_CATCH_UP: 'maybe' }),
            CatchUpConfigError
        );
    });

    it('ignores the limits while catch-up is off', () => {
        const config = requireCatchUpConfig({
            BF_RELAY_CATCH_UP: 'false',
            BF_RELAY_CATCH_UP_MAX_MESSAGES: '5000',
        });
        assert.equal(config.enabled, false);
    });
});
