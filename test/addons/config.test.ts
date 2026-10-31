import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    AddonConfigError,
    parseAddonConfig,
    requireAddonConfig,
} from '../../src/addons/config';

describe('parseAddonConfig', () => {
    it('defaults to everything off in dry-run', () => {
        assert.deepEqual(parseAddonConfig({}), {
            ok: true,
            config: {
                enabled: false,
                guildSync: false,
                history: false,
                identity: false,
                initialMode: 'dry-run',
            },
        });
    });

    it('keeps add-ons off when the master switch is off', () => {
        const result = parseAddonConfig({
            BF_ADDON_GUILD_SYNC: 'true',
            BF_ADDON_IDENTITY: 'true',
        });
        assert.ok(result.ok);
        assert.equal(result.config.guildSync, false);
        assert.equal(result.config.identity, false);
    });

    it('turns on only the add-ons that are switched on', () => {
        const result = parseAddonConfig({
            BF_ADDONS_ENABLED: 'yes',
            BF_ADDON_GUILD_SYNC: '1',
            BF_ADDON_HISTORY: 'false',
            BF_ADDONS_MODE: 'read-only',
        });
        assert.ok(result.ok);
        assert.equal(result.config.guildSync, true);
        assert.equal(result.config.history, false);
        assert.equal(result.config.identity, false);
        assert.equal(result.config.initialMode, 'read-only');
    });

    it('rejects an unknown boolean instead of reading it as false', () => {
        const result = parseAddonConfig({ BF_ADDONS_ENABLED: 'ture' });
        assert.equal(result.ok, false);
        assert.match(!result.ok ? result.error : '', /BF_ADDONS_ENABLED/);
    });

    it('rejects apply mode from the environment', () => {
        const result = parseAddonConfig({ BF_ADDONS_MODE: 'apply' });
        assert.equal(result.ok, false);
        assert.match(!result.ok ? result.error : '', /settings table/);
    });

    it('rejects an unknown mode', () => {
        const result = parseAddonConfig({ BF_ADDONS_MODE: 'yolo' });
        assert.equal(result.ok, false);
    });
});

describe('requireAddonConfig', () => {
    it('throws AddonConfigError on a bad value', () => {
        assert.throws(
            () => requireAddonConfig({ BF_ADDON_HISTORY: 'maybe' }),
            AddonConfigError
        );
    });
});
