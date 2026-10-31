import type { AddonModeController } from './mode';

/** The logging calls add-on code needs. Bifröst's winston logger fits it. */
export interface AddonLogger {
    info(message: string, ...meta: unknown[]): void;
    warn(message: string, ...meta: unknown[]): void;
    error(message: string, ...meta: unknown[]): void;
}

export type IsolatedResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown };

/**
 * The failure-isolation boundary between the relay and the add-ons
 * (safety guard 15).
 *
 * Every add-on entry point — start, stop, event handlers, timers — runs
 * through this boundary. An unexpected error is caught here, logged, and
 * switches all add-ons to read-only. It never propagates into the relay.
 */
export class IsolationBoundary {
    constructor(
        private readonly modeController: AddonModeController,
        private readonly logger: AddonLogger
    ) {}

    /** Runs one add-on task. Errors from `fn` never escape. */
    async run<T>(
        addon: string,
        task: string,
        fn: () => Promise<T> | T
    ): Promise<IsolatedResult<T>> {
        try {
            return { ok: true, value: await fn() };
        } catch (error) {
            this.trip(addon, task, error);
            return { ok: false, error };
        }
    }

    /**
     * Wraps an event listener so it can be passed to an event emitter.
     * The listener's promise is always handled inside the boundary.
     */
    handler<A extends unknown[]>(
        addon: string,
        task: string,
        fn: (...args: A) => Promise<void> | void
    ): (...args: A) => void {
        return (...args: A) => {
            void this.run(addon, task, () => fn(...args));
        };
    }

    private trip(addon: string, task: string, error: unknown): void {
        const where = `${addon}/${task}`;
        const changed = this.modeController.tripReadOnly(
            `unexpected error in ${where}`
        );
        this.logger.error(`[addons] Unexpected error in ${where}:`, error);
        if (changed) {
            this.logger.error(
                `[addons] Add-ons switched to read-only after an error in ${where}. The relay keeps running.`
            );
        }
    }
}
