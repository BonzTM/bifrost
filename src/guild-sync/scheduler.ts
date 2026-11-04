/**
 * Decides when a cycle runs (design: Triggers). Events only schedule a
 * cycle; the cycle reads everything fresh. Cycles never overlap: a trigger
 * during a run queues exactly one more run.
 */

export interface SchedulerTimers {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
    setInterval(fn: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
}

export interface SchedulerOptions {
    /** Quiet time after the last event before a cycle runs. */
    readonly debounceMs: number;
    /** Longest an event burst can postpone a cycle. */
    readonly maxWaitMs: number;
    /** Periodic full check. */
    readonly intervalMs: number;
}

export const DEFAULT_SCHEDULE: SchedulerOptions = {
    debounceMs: 10_000,
    maxWaitMs: 60_000,
    intervalMs: 10 * 60_000,
};

const NODE_TIMERS: SchedulerTimers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

export class SyncScheduler {
    private interval: unknown = null;
    private debounce: unknown = null;
    private firstEventAt: number | null = null;
    private running: Promise<void> | null = null;
    private rerun = false;
    private stopped = true;

    /** `run` must not reject; wrap it in the isolation boundary. */
    constructor(
        private readonly run: () => Promise<void>,
        private readonly options: SchedulerOptions = DEFAULT_SCHEDULE,
        private readonly timers: SchedulerTimers = NODE_TIMERS,
        private readonly clock: () => number = Date.now
    ) {
        const { debounceMs, maxWaitMs, intervalMs } = options;
        if (debounceMs <= 0 || maxWaitMs < debounceMs || intervalMs <= 0) {
            throw new RangeError('Invalid scheduler timings');
        }
    }

    /** Starts the periodic check and schedules a first cycle. */
    start(): void {
        if (!this.stopped) return;
        this.stopped = false;
        this.interval = this.timers.setInterval(
            () => this.fire(),
            this.options.intervalMs
        );
        this.notify();
    }

    /** A source event happened. Runs a cycle once events go quiet. */
    notify(): void {
        if (this.stopped) return;
        const now = this.clock();
        this.firstEventAt ??= now;
        const waited = now - this.firstEventAt;
        const delay = Math.min(
            this.options.debounceMs,
            this.options.maxWaitMs - waited
        );
        if (this.debounce !== null) this.timers.clearTimeout(this.debounce);
        this.debounce = this.timers.setTimeout(
            () => this.fire(),
            Math.max(delay, 0)
        );
    }

    /** Stops all timers and waits for a running cycle to finish. */
    async stop(): Promise<void> {
        this.stopped = true;
        if (this.interval !== null) this.timers.clearInterval(this.interval);
        if (this.debounce !== null) this.timers.clearTimeout(this.debounce);
        this.interval = null;
        this.debounce = null;
        this.rerun = false;
        await this.running;
    }

    private fire(): void {
        if (this.debounce !== null) this.timers.clearTimeout(this.debounce);
        this.debounce = null;
        this.firstEventAt = null;
        if (this.stopped) return;
        if (this.running) {
            this.rerun = true;
            return;
        }
        this.running = this.run().finally(() => {
            this.running = null;
            if (this.rerun && !this.stopped) {
                this.rerun = false;
                this.fire();
            }
        });
    }
}
