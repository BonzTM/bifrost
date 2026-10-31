import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { IsolationBoundary } from '../../src/addons/isolation';
import { AddonModeController } from '../../src/addons/mode';
import { createRecordingLogger } from './fakes';

function setup() {
    const mode = new AddonModeController('apply');
    const logger = createRecordingLogger();
    return { mode, logger, boundary: new IsolationBoundary(mode, logger) };
}

describe('IsolationBoundary.run', () => {
    it('returns the value and keeps the mode on success', async () => {
        const { mode, boundary } = setup();
        const result = await boundary.run('test', 'task', async () => 42);
        assert.deepEqual(result, { ok: true, value: 42 });
        assert.equal(mode.mode, 'apply');
    });

    it('catches a thrown error and switches to read-only', async () => {
        const { mode, logger, boundary } = setup();
        const result = await boundary.run('test', 'task', () => {
            throw new Error('boom');
        });
        assert.equal(result.ok, false);
        assert.equal(mode.mode, 'read-only');
        assert.match(mode.readOnlyReason ?? '', /test\/task/);
        assert.ok(logger.entries.some((entry) => entry.level === 'error'));
    });

    it('catches a rejected promise and switches to read-only', async () => {
        const { mode, boundary } = setup();
        const result = await boundary.run('test', 'task', () =>
            Promise.reject(new Error('boom'))
        );
        assert.equal(result.ok, false);
        assert.equal(mode.mode, 'read-only');
    });
});

describe('IsolationBoundary.handler', () => {
    it('keeps other listeners on the emitter running after an add-on error', async () => {
        const { mode, boundary } = setup();
        const emitter = new EventEmitter();
        const relayed: string[] = [];
        let unhandled = 0;
        const onUnhandled = () => unhandled++;
        process.on('unhandledRejection', onUnhandled);

        // Stands in for the relay listener, registered before the add-on.
        emitter.on('message', (content: string) => relayed.push(content));
        emitter.on(
            'message',
            boundary.handler('identity', 'dm', async () => {
                throw new Error('boom');
            })
        );

        assert.doesNotThrow(() => emitter.emit('message', 'one'));
        await new Promise((resolve) => setImmediate(resolve));
        emitter.emit('message', 'two');
        await new Promise((resolve) => setImmediate(resolve));
        process.off('unhandledRejection', onUnhandled);

        assert.deepEqual(relayed, ['one', 'two']);
        assert.equal(mode.mode, 'read-only');
        assert.equal(unhandled, 0);
    });
});
