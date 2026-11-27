import type { FieldChange, Finding, JsonValue, PlanOp } from './ops';
import type { Fields } from './project';
import type { ChannelSnap, ThreadSnap } from './snapshot';
import { THREAD_ONLY_TYPES } from './snapshot';

/**
 * Thread and forum post settings sync both ways; the rest of the server
 * structure syncs from the source only. Each setting is compared three
 * ways: the base (the fields last written or agreed, else the last
 * healthy source snapshot), the source and the destination.
 *
 * - Only the source moved: it is written to the destination, as before.
 * - Only the destination moved: it is written back to the source thread.
 * - Both moved to different values: the source wins, with a finding.
 * - Both moved to the same value: the base records it, with no write.
 *
 * The base records what bifröst wrote, so its own writes are never taken
 * for a person's edit on either side. `sync enforce on` does not revert
 * thread settings: a destination edit is written back instead.
 * See docs/design/two-way-thread-settings.md.
 */

/** Settings a destination edit may write back to the source thread. */
export const WRITE_BACK_FIELDS: ReadonlySet<string> = new Set([
    'name',
    'archived',
    'locked',
    'tags',
    'pinned',
    'rateLimitPerUser',
    'autoArchiveDuration',
]);

/** One mapped thread pair, compared three ways. */
export interface ThreadCompare {
    /** Source edits, written to the destination. */
    readonly forward: readonly FieldChange[];
    /** Destination edits, written back: `from` source, `to` destination. */
    readonly back: readonly FieldChange[];
    /** Fields equal on both sides, with their values. */
    readonly agreed: Readonly<Record<string, JsonValue>>;
    /** True when an agreed field differs from the base. */
    readonly stale: boolean;
    /** Fields both sides changed to different values. */
    readonly conflicts: readonly string[];
    /** Destination edits that are not written back, only reported. */
    readonly drifted: readonly string[];
}

const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);

type Mover = 'source' | 'destination' | 'both' | 'unknown';

/**
 * Which side moved a field that differs. A base without the field counts
 * as a source change, as in compareFields; no base at all leaves the
 * mover unknown, which is reported as drift and never written.
 */
function moverOf(
    field: string,
    source: JsonValue,
    dest: JsonValue,
    base: Fields | null
): Mover {
    if (base === null) return 'unknown';
    if (!(field in base)) return 'source';
    const sourceMoved = !same(base[field], source);
    const destMoved = !same(base[field], dest);
    if (sourceMoved && destMoved) return 'both';
    return sourceMoved ? 'source' : 'destination';
}

interface Compared {
    forward: FieldChange[];
    back: FieldChange[];
    agreed: Record<string, JsonValue>;
    stale: boolean;
    conflicts: string[];
    drifted: string[];
}

/** Sorts one differing field into the compare result. */
function sortField(
    out: Compared,
    field: string,
    pair: { source: JsonValue; dest: JsonValue },
    mover: Mover,
    writable: ReadonlySet<string>
): void {
    const { source, dest } = pair;
    if (mover === 'source' || mover === 'both') {
        out.forward.push({ field, from: dest, to: source });
        if (mover === 'both') out.conflicts.push(field);
    } else if (mover === 'destination' && writable.has(field)) {
        out.back.push({ field, from: source, to: dest });
    } else out.drifted.push(field);
}

/**
 * Compares a thread's projected fields three ways. `writable` names the
 * fields a destination edit may be written back for.
 */
export function compareThread(
    source: Fields,
    dest: Fields,
    base: Fields | null,
    writable: ReadonlySet<string>
): ThreadCompare {
    const out: Compared = {
        forward: [],
        back: [],
        agreed: {},
        stale: false,
        conflicts: [],
        drifted: [],
    };
    for (const [field, value] of Object.entries(source)) {
        if (!(field in dest)) continue;
        const other = dest[field];
        if (same(value, other)) {
            out.agreed[field] = value;
            if (base !== null && !same(base[field], value)) out.stale = true;
            continue;
        }
        const mover = moverOf(field, value, other, base);
        sortField(out, field, { source: value, dest: other }, mover, writable);
    }
    return out;
}

/** True when every tag on either post exists in both forums. */
function tagsShared(
    names: readonly string[],
    sourceParent: ChannelSnap | undefined,
    destParent: ChannelSnap | undefined
): boolean {
    if (!sourceParent || !destParent) return names.length === 0;
    return names.every(
        (name) =>
            sourceParent.tags.includes(name) && destParent.tags.includes(name)
    );
}

/**
 * The fields a destination edit of this thread may be written back for.
 * A pin exists only on forum and media posts (Discord ChannelFlags.Pinned,
 * discord-api-types payloads/v10/channel.d.ts:621). Tags are written back
 * only while every tag on both posts exists in both forums: each writer
 * skips a tag its forum lacks, and writing back a list one side could not
 * hold would strip that tag from the other side.
 */
export function writableFields(
    source: ThreadSnap,
    dest: ThreadSnap,
    parents: { source?: ChannelSnap; dest?: ChannelSnap }
): ReadonlySet<string> {
    const fields = new Set(WRITE_BACK_FIELDS);
    const forum =
        parents.source !== undefined &&
        THREAD_ONLY_TYPES.has(parents.source.type);
    if (!forum) fields.delete('pinned');
    const names = [...new Set([...source.tags, ...dest.tags])];
    if (!tagsShared(names, parents.source, parents.dest)) {
        fields.delete('tags');
    }
    return fields;
}

/** A mapped thread pair, and whether its write-backs must wait. */
export interface ThreadPair {
    readonly sourceId: string;
    readonly destId: string;
    /**
     * True while the pair's history import is not finished: the import
     * opens and closes the destination thread, so its state is not a
     * person's edit (history/importer.ts whileOpen).
     */
    readonly held: boolean;
}

const settledWith = (
    agreed: Readonly<Record<string, JsonValue>>,
    changes: readonly FieldChange[]
): Record<string, JsonValue> => ({
    ...agreed,
    ...Object.fromEntries(changes.map((c) => [c.field, c.to])),
});

/** The update that carries source edits to the destination, if any. */
function forwardOp(pair: ThreadPair, compared: ThreadCompare): PlanOp[] {
    if (compared.forward.length === 0) return [];
    return [
        {
            op: 'update',
            kind: 'thread',
            sourceId: pair.sourceId,
            destId: pair.destId,
            changes: compared.forward,
            settled: settledWith(compared.agreed, compared.forward),
        },
    ];
}

/**
 * The write-back of destination edits, or a record of agreed fields when
 * nothing else would record them. None while the pair is held.
 */
function backOp(pair: ThreadPair, compared: ThreadCompare): PlanOp[] {
    const { back, forward, stale } = compared;
    if (pair.held && back.length > 0) return [];
    const recordOnly = back.length === 0 && forward.length === 0 && stale;
    if (back.length === 0 && !recordOnly) return [];
    return [
        {
            op: 'write-back',
            kind: 'thread',
            sourceId: pair.sourceId,
            destId: pair.destId,
            changes: back,
            settled: settledWith(compared.agreed, back),
        },
    ];
}

/** The findings one compared pair reports. */
function pairFindings(pair: ThreadPair, compared: ThreadCompare): Finding[] {
    const findings: Finding[] = [];
    const finding = (type: Finding['type'], detail: string) =>
        findings.push({ type, kind: 'thread', id: pair.destId, detail });
    if (compared.conflicts.length > 0) {
        finding(
            'conflict',
            `edited on both sides in one sync window: ${compared.conflicts.join(', ')}; the source's value is kept`
        );
    }
    if (pair.held && compared.back.length > 0) {
        const fields = compared.back.map((c) => c.field).join(', ');
        finding(
            'skipped',
            `edited on the destination: ${fields}; written back once this thread's history import finishes`
        );
    }
    if (compared.drifted.length > 0) {
        finding(
            'drift',
            `edited on the destination: ${compared.drifted.join(', ')}`
        );
    }
    return findings;
}

/** The ops and findings one compared thread pair needs. */
export function planThreadPair(
    pair: ThreadPair,
    compared: ThreadCompare
): { ops: PlanOp[]; findings: Finding[] } {
    return {
        ops: [...forwardOp(pair, compared), ...backOp(pair, compared)],
        findings: pairFindings(pair, compared),
    };
}
