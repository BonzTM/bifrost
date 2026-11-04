import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    SyncScheduler,
    type SchedulerTimers,
} from '../../src/guild-sync/scheduler';

/** Manual timers: tests move the clock and fire what is due. */
class ManualTimers implements SchedulerTimers {
    now = 0;
    private seq = 0;
    private readonly pending = new Map<
        number,
        { at: number; fn: () => void; every: number | null }
    >();

    setTimeout(fn: () => void, ms: number) {
        this.pending.set(++this.seq, { at: this.now + ms, fn, every: null });
        return this.seq;
    }

    setInterval(fn: () => void, ms: number) {
        this.pending.set(++this.seq, { at: this.now + ms, fn, every: ms });
        return this.seq;
    }

    clearTimeout(handle: unknown) {
        this.pending.delete(handle as number);
    }

    clearInterval(handle: unknown) {
        this.pending.delete(handle as number);
    }

    get size() {
        return this.pending.size;
    }

    /** Advances time, firing due timers in order. Bounded by `limit`. */
    advance(ms: number, limit = 100) {
        const end = this.now + ms;
        for (let i = 0; i < limit; i++) {
            const due = [...this.pending]
                .filter(([, t]) => t.at <= end)
                .sort(([, a], [, b]) => a.at - b.at)[0];
            if (!due) break;
            const [id, timer] = due;
            this.now = timer.at;
            if (timer.every === null) this.pending.delete(id);
            else timer.at += timer.every;
            timer.fn();
        }
        this.now = end;
    }
}

const OPTIONS = { debounceMs: 10, maxWaitMs: 30, intervalMs: 1000 };
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(run: () => Promise<void> = async () => {}) {
    const timers = new ManualTimers();
    let runs = 0;
    const scheduler = new SyncScheduler(
        async () => {
            runs += 1;
            await run();
        },
        OPTIONS,
        timers,
        () => timers.now
    );
    return { timers, scheduler, runs: () => runs };
}

describe('SyncScheduler', () => {
    it('runs once after a burst of events goes quiet', async () => {
        const { timers, scheduler, runs } = setup();
        scheduler.start();
        timers.advance(10);
        await flush();
        assert.equal(runs(), 1);
        for (let i = 0; i < 5; i++) {
            scheduler.notify();
            timers.advance(5);
        }
        assert.equal(runs(), 1);
        timers.advance(10);
        await flush();
        assert.equal(runs(), 2);
    });

    it('lets a steady stream postpone a cycle by at most maxWaitMs', async () => {
        const { timers, scheduler, runs } = setup();
        scheduler.start();
        timers.advance(10);
        await flush();
        for (let i = 0; i < 8; i++) {
            scheduler.notify();
            timers.advance(5);
        }
        await flush();
        assert.equal(runs(), 2);
    });

    it('never overlaps cycles and queues one rerun', async () => {
        let release: () => void = () => {};
        const { timers, scheduler, runs } = setup(
            () => new Promise<void>((resolve) => (release = resolve))
        );
        scheduler.start();
        timers.advance(10);
        for (let i = 0; i < 3; i++) {
            scheduler.notify();
            timers.advance(10);
        }
        assert.equal(runs(), 1);
        release();
        await flush();
        assert.equal(runs(), 2);
        release();
        await flush();
        assert.equal(runs(), 2);
    });

    it('stops its timers and waits for a running cycle', async () => {
        let release: () => void = () => {};
        const { timers, scheduler } = setup(
            () => new Promise<void>((resolve) => (release = resolve))
        );
        scheduler.start();
        timers.advance(10);
        let stopped = false;
        const stopping = scheduler.stop().then(() => (stopped = true));
        await flush();
        assert.equal(stopped, false);
        release();
        await stopping;
        assert.equal(timers.size, 0);
    });

    it('rejects invalid timings', () => {
        assert.throws(
            () =>
                new SyncScheduler(async () => {}, { ...OPTIONS, maxWaitMs: 1 })
        );
    });
});
