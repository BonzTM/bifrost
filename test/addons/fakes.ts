import type { AddonLogger } from '../../src/addons/isolation';

export interface LogEntry {
    level: 'info' | 'warn' | 'error';
    message: string;
    meta: unknown[];
}

/** A logger that records calls instead of writing them. */
export function createRecordingLogger(): AddonLogger & { entries: LogEntry[] } {
    const entries: LogEntry[] = [];
    const record =
        (level: LogEntry['level']) =>
        (message: string, ...meta: unknown[]) => {
            entries.push({ level, message, meta });
        };
    return {
        entries,
        info: record('info'),
        warn: record('warn'),
        error: record('error'),
    };
}
