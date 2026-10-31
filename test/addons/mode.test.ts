import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AddonModeController } from '../../src/addons/mode';

describe('AddonModeController', () => {
    it('allows writes only in apply mode', () => {
        assert.equal(new AddonModeController('apply').canWrite(), true);
        assert.equal(new AddonModeController('dry-run').canWrite(), false);
        assert.equal(new AddonModeController('read-only').canWrite(), false);
    });

    it('trips to read-only once and keeps the first reason', () => {
        const mode = new AddonModeController('apply');
        assert.equal(mode.tripReadOnly('first'), true);
        assert.equal(mode.tripReadOnly('second'), false);
        assert.equal(mode.mode, 'read-only');
        assert.equal(mode.readOnlyReason, 'first');
        assert.equal(mode.canWrite(), false);
    });
});
