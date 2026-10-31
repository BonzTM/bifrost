import type { AddonMode } from './config';

/**
 * Holds the current add-on mode for the whole process.
 *
 * Read-only is sticky: once tripped, it stays until the process restarts or
 * an admin changes it through the settings table. Nothing in-process can
 * leave read-only on its own.
 */
export class AddonModeController {
    private current: AddonMode;
    private reason: string | null = null;

    constructor(initial: AddonMode) {
        this.current = initial;
    }

    get mode(): AddonMode {
        return this.current;
    }

    get readOnlyReason(): string | null {
        return this.reason;
    }

    /** True only in apply mode. Every destination write must check this. */
    canWrite(): boolean {
        return this.current === 'apply';
    }

    /**
     * Switches to read-only. Returns true if the mode changed, false if it
     * was already read-only. The first reason is kept.
     */
    tripReadOnly(reason: string): boolean {
        if (this.current === 'read-only') return false;
        this.current = 'read-only';
        this.reason = reason.trim() || 'unspecified';
        return true;
    }
}
