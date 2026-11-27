import { parseStrictBool } from '../../addons/config';

/**
 * Relay catch-up settings, read once at startup. Catch-up belongs to the
 * relay, not to an add-on, so it runs whether add-ons are on or off.
 */

type Env = Readonly<Record<string, string | undefined>>;

export interface CatchUpConfig {
    /** BF_RELAY_CATCH_UP. Default on. */
    readonly enabled: boolean;
    /** BF_RELAY_CATCH_UP_MAX_AGE_HOURS, in ms: older messages stay missed. */
    readonly maxAgeMs: number;
    /** BF_RELAY_CATCH_UP_MAX_MESSAGES: per channel and direction. */
    readonly maxMessages: number;
}

export const DEFAULT_MAX_AGE_HOURS = 24;
/** One week. */
export const MAX_MAX_AGE_HOURS = 168;
export const DEFAULT_MAX_MESSAGES = 100;
/** One page of Discord's and Fluxer's message list (fetch limit 1-100). */
export const MAX_MAX_MESSAGES = 100;

const HOUR_MS = 60 * 60_000;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Parses a whole number from 1 to `max`; unset or empty is `fallback`. */
function parseBounded(
    name: string,
    value: string | undefined,
    fallback: number,
    max: number
): Parsed<number> {
    const text = (value ?? '').trim();
    if (text === '') return { ok: true, value: fallback };
    const parsed = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
        return {
            ok: false,
            error: `${name} must be a whole number from 1 to ${max}`,
        };
    }
    return { ok: true, value: parsed };
}

/** Unset or empty is on; otherwise a strict boolean (src/addons/config.ts). */
function parseEnabled(value: string | undefined): Parsed<boolean> {
    if ((value ?? '').trim() === '') return { ok: true, value: true };
    return parseStrictBool('BF_RELAY_CATCH_UP', value);
}

export type CatchUpConfigResult =
    | { readonly ok: true; readonly config: CatchUpConfig }
    | { readonly ok: false; readonly error: string };

const OFF: CatchUpConfig = {
    enabled: false,
    maxAgeMs: DEFAULT_MAX_AGE_HOURS * HOUR_MS,
    maxMessages: DEFAULT_MAX_MESSAGES,
};

/**
 * Parses the catch-up settings without side effects. A bad
 * BF_RELAY_CATCH_UP is always an error; the limits are checked only while
 * catch-up is on, as add-on settings are (src/addons/config.ts:358).
 */
export function parseCatchUpConfig(env: Env): CatchUpConfigResult {
    const enabled = parseEnabled(env.BF_RELAY_CATCH_UP);
    if (enabled.ok && !enabled.value) return { ok: true, config: OFF };
    const hours = parseBounded(
        'BF_RELAY_CATCH_UP_MAX_AGE_HOURS',
        env.BF_RELAY_CATCH_UP_MAX_AGE_HOURS,
        DEFAULT_MAX_AGE_HOURS,
        MAX_MAX_AGE_HOURS
    );
    const messages = parseBounded(
        'BF_RELAY_CATCH_UP_MAX_MESSAGES',
        env.BF_RELAY_CATCH_UP_MAX_MESSAGES,
        DEFAULT_MAX_MESSAGES,
        MAX_MAX_MESSAGES
    );
    const errors = [enabled, hours, messages].flatMap((p) =>
        p.ok ? [] : [p.error]
    );
    if (!enabled.ok || !hours.ok || !messages.ok)
        return { ok: false, error: errors.join('; ') };
    return {
        ok: true,
        config: {
            enabled: enabled.value,
            maxAgeMs: hours.value * HOUR_MS,
            maxMessages: messages.value,
        },
    };
}

export class CatchUpConfigError extends Error {
    constructor(message: string) {
        super(`Invalid relay catch-up configuration: ${message}`);
        this.name = 'CatchUpConfigError';
    }
}

/** Parses the catch-up settings, throwing so startup fails on a bad one. */
export function requireCatchUpConfig(env: Env): CatchUpConfig {
    const result = parseCatchUpConfig(env);
    if (!result.ok) throw new CatchUpConfigError(result.error);
    return result.config;
}
