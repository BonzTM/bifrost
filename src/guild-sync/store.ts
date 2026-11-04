import { randomUUID } from 'node:crypto';
import { QueryTypes, type Sequelize } from 'sequelize';
import {
    OBJECT_KINDS,
    OBJECT_STATES,
    SYNC_DIRECTIONS,
    SYNC_MODES,
    TABLES,
    type SnapshotSide,
    type SyncDirection,
    type SyncMode,
} from '../addons/db/schema';
import type { MissingUpdate, GuardSettings } from './guards';
import type { ShrinkLimits } from './health';
import type { MapRow } from './ops';
import type { Plan } from './plan';
import type { GuildSnapshot } from './snapshot';
import { countObjects } from './snapshot';

/** `addon_settings` for one guild link. */
export interface SyncSettings extends GuardSettings, ShrinkLimits {
    readonly mode: SyncMode;
    readonly direction: SyncDirection;
    readonly killSwitch: boolean;
}

/** The database access one cycle needs. The cycle depends only on this. */
export interface GuildSyncStore {
    /** Runs `fn` while holding the leader lock (guard 12), or not at all. */
    withLeaderLock<T>(
        holder: string,
        fn: () => Promise<T>
    ): Promise<{ ran: true; value: T } | { ran: false }>;
    loadSettings(guildLinkId: string): Promise<SyncSettings>;
    loadObjectMap(guildLinkId: string): Promise<MapRow[]>;
    lastSnapshot(
        guildLinkId: string,
        side: SnapshotSide,
        healthyOnly: boolean
    ): Promise<GuildSnapshot | null>;
    saveSnapshot(
        guildLinkId: string,
        snapshot: GuildSnapshot,
        healthy: boolean,
        takenAt: Date
    ): Promise<void>;
    saveMissing(updates: readonly MissingUpdate[], now: Date): Promise<void>;
    savePlan(plan: Plan, now: Date): Promise<void>;
    removalsSince(guildLinkId: string, since: Date): Promise<number>;
    pruneSnapshots(before: Date): Promise<void>;
}

/** Arbitrary constant: 'bfsg' in ASCII. Shared by every fork instance. */
export const LEADER_LOCK_KEY = 0x62667367;

export class StoreDataError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'StoreDataError';
    }
}

type Row = Record<string, unknown>;

function oneOf<T extends string>(
    values: readonly T[],
    value: unknown,
    field: string
): T {
    const match = values.find((candidate) => candidate === value);
    if (match === undefined) {
        throw new StoreDataError(`${field} has an unknown value`);
    }
    return match;
}

function int(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new StoreDataError(`${field} is not an integer`);
    }
    return value;
}

function optionalId(value: unknown, field: string): string | null {
    if (value === null) return null;
    if (typeof value !== 'string')
        throw new StoreDataError(`${field} is not a string`);
    return value;
}

/** Parses an `addon_settings` row. Rows are validated, not trusted. */
export function parseSettings(row: Row): SyncSettings {
    if (typeof row.killSwitch !== 'boolean') {
        throw new StoreDataError('killSwitch is not a boolean');
    }
    return {
        mode: oneOf(SYNC_MODES, row.mode, 'mode'),
        direction: oneOf(SYNC_DIRECTIONS, row.direction, 'direction'),
        killSwitch: row.killSwitch,
        shrinkPercent: int(row.shrinkPercent, 'shrinkPercent'),
        shrinkMinObjects: int(row.shrinkMinObjects, 'shrinkMinObjects'),
        confirmChecks: int(row.confirmChecks, 'confirmChecks'),
        confirmMinutes: int(row.confirmMinutes, 'confirmMinutes'),
        gracePeriodDays: int(row.gracePeriodDays, 'gracePeriodDays'),
        deleteBudgetPerCycle: int(
            row.deleteBudgetPerCycle,
            'deleteBudgetPerCycle'
        ),
        deleteBudgetPerDay: int(row.deleteBudgetPerDay, 'deleteBudgetPerDay'),
        writeCapPerCycle: int(row.writeCapPerCycle, 'writeCapPerCycle'),
    };
}

/** Parses an `addon_object_map` row. */
export function parseMapRow(row: Row): MapRow {
    if (typeof row.id !== 'string' || typeof row.createdBySync !== 'boolean') {
        throw new StoreDataError('object map row is malformed');
    }
    const missingSince = row.missingSince;
    if (missingSince !== null && !(missingSince instanceof Date)) {
        throw new StoreDataError('missingSince is not a date');
    }
    return {
        id: row.id,
        kind: oneOf(OBJECT_KINDS, row.kind, 'kind'),
        discordId: optionalId(row.discordId, 'discordId'),
        fluxerId: optionalId(row.fluxerId, 'fluxerId'),
        state: oneOf(OBJECT_STATES, row.state, 'state'),
        createdBySync: row.createdBySync,
        missingSince,
        missingCount: int(row.missingCount, 'missingCount'),
    };
}

const SNAPSHOT_ARRAYS = ['roles', 'channels', 'emojis', 'stickers'] as const;

/**
 * Checks the top-level shape of a stored snapshot. Only the fork writes
 * this column, so a shallow check catches corruption and old formats.
 */
export function parseSnapshot(payload: unknown): GuildSnapshot {
    if (typeof payload !== 'object' || payload === null) {
        throw new StoreDataError('snapshot payload is not an object');
    }
    const snap = payload as Row;
    if (
        typeof snap.guildId !== 'string' ||
        typeof snap.everyoneRoleId !== 'string'
    ) {
        throw new StoreDataError('snapshot payload has no guild IDs');
    }
    for (const key of SNAPSHOT_ARRAYS) {
        if (!Array.isArray(snap[key])) {
            throw new StoreDataError(`snapshot payload has no ${key} list`);
        }
    }
    return payload as GuildSnapshot;
}

/** Upper bound on map rows per guild link: roles + channels + expressions. */
export const MAX_MAP_ROWS = 5_000;

/** {@link GuildSyncStore} on the fork's Postgres database. */
export class PostgresGuildSyncStore implements GuildSyncStore {
    constructor(private readonly db: Sequelize) {
        if (db.getDialect() !== 'postgres') {
            throw new StoreDataError('guild-sync needs Postgres');
        }
    }

    async withLeaderLock<T>(
        holder: string,
        fn: () => Promise<T>
    ): Promise<{ ran: true; value: T } | { ran: false }> {
        // A transaction-scoped advisory lock is released on commit, on
        // rollback and when the connection dies, so it never goes stale.
        return this.db.transaction(async (transaction) => {
            const [row] = await this.db.query<{ locked: boolean }>(
                'SELECT pg_try_advisory_xact_lock($1) AS locked',
                {
                    bind: [LEADER_LOCK_KEY],
                    type: QueryTypes.SELECT,
                    transaction,
                }
            );
            if (!row?.locked) return { ran: false as const };
            await this.db.query(
                `INSERT INTO ${TABLES.leaderLock} (id, holder, "acquiredAt", "heartbeatAt") VALUES (1, $1, now(), now())
                 ON CONFLICT (id) DO UPDATE SET holder = $1, "acquiredAt" = now(), "heartbeatAt" = now()`,
                { bind: [holder] }
            );
            return { ran: true as const, value: await fn() };
        });
    }

    async loadSettings(guildLinkId: string): Promise<SyncSettings> {
        // Insert-if-missing keeps the defaults in one place: the migration.
        await this.db.query(
            `INSERT INTO ${TABLES.settings} ("guildLinkId", "updatedAt") VALUES ($1, now()) ON CONFLICT ("guildLinkId") DO NOTHING`,
            { bind: [guildLinkId] }
        );
        const rows = await this.db.query<Row>(
            `SELECT * FROM ${TABLES.settings} WHERE "guildLinkId" = $1`,
            { bind: [guildLinkId], type: QueryTypes.SELECT }
        );
        if (rows.length !== 1)
            throw new StoreDataError('settings row is missing');
        return parseSettings(rows[0]);
    }

    async loadObjectMap(guildLinkId: string): Promise<MapRow[]> {
        const rows = await this.db.query<Row>(
            `SELECT id, kind, "discordId", "fluxerId", state, "createdBySync", "missingSince", "missingCount"
             FROM ${TABLES.objectMap} WHERE "guildLinkId" = $1 ORDER BY id LIMIT $2`,
            { bind: [guildLinkId, MAX_MAP_ROWS + 1], type: QueryTypes.SELECT }
        );
        if (rows.length > MAX_MAP_ROWS) {
            throw new StoreDataError(
                `object map has over ${MAX_MAP_ROWS} rows`
            );
        }
        return rows.map(parseMapRow);
    }

    async lastSnapshot(
        guildLinkId: string,
        side: SnapshotSide,
        healthyOnly: boolean
    ): Promise<GuildSnapshot | null> {
        const rows = await this.db.query<{ payload: unknown }>(
            `SELECT payload FROM ${TABLES.snapshots}
             WHERE "guildLinkId" = $1 AND side = $2 AND (healthy OR NOT $3)
             ORDER BY "takenAt" DESC LIMIT 1`,
            { bind: [guildLinkId, side, healthyOnly], type: QueryTypes.SELECT }
        );
        return rows.length === 0 ? null : parseSnapshot(rows[0].payload);
    }

    async saveSnapshot(
        guildLinkId: string,
        snapshot: GuildSnapshot,
        healthy: boolean,
        takenAt: Date
    ): Promise<void> {
        await this.db.query(
            `INSERT INTO ${TABLES.snapshots} (id, "guildLinkId", side, "takenAt", healthy, "objectCounts", payload)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
            {
                bind: [
                    randomUUID(),
                    guildLinkId,
                    snapshot.side,
                    takenAt,
                    healthy,
                    JSON.stringify(countObjects(snapshot)),
                    JSON.stringify(snapshot),
                ],
            }
        );
    }

    async saveMissing(
        updates: readonly MissingUpdate[],
        now: Date
    ): Promise<void> {
        if (updates.length === 0) return;
        await this.db.transaction(async (transaction) => {
            for (const update of updates) {
                await this.db.query(
                    `UPDATE ${TABLES.objectMap} SET "missingCount" = $2, "missingSince" = $3, "updatedAt" = $4 WHERE id = $1`,
                    {
                        bind: [
                            update.rowId,
                            update.missingCount,
                            update.missingSince,
                            now,
                        ],
                        transaction,
                    }
                );
            }
        });
    }

    async savePlan(plan: Plan, now: Date): Promise<void> {
        await this.db.query(
            `INSERT INTO ${TABLES.plans} (id, "guildLinkId", direction, status, ops, "abortReason", "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $7)`,
            {
                bind: [
                    plan.id,
                    plan.guildLinkId,
                    plan.direction,
                    plan.status,
                    JSON.stringify(plan.body),
                    plan.abortReason,
                    now,
                ],
            }
        );
    }

    async removalsSince(guildLinkId: string, since: Date): Promise<number> {
        const [row] = await this.db.query<{ count: string }>(
            `SELECT count(*) AS count FROM ${TABLES.auditLog}
             WHERE "guildLinkId" = $1 AND op IN ('archive', 'hard-delete') AND result = 'ok' AND at >= $2`,
            { bind: [guildLinkId, since], type: QueryTypes.SELECT }
        );
        const count = Number(row?.count);
        if (!Number.isInteger(count))
            throw new StoreDataError('removal count is not a number');
        return count;
    }

    async pruneSnapshots(before: Date): Promise<void> {
        // Keeps the newest healthy snapshot per side: the shrink check and
        // a restore both need it, however old it is.
        await this.db.query(
            `DELETE FROM ${TABLES.snapshots} WHERE "takenAt" < $1 AND id NOT IN (
                SELECT DISTINCT ON ("guildLinkId", side) id FROM ${TABLES.snapshots}
                WHERE healthy ORDER BY "guildLinkId", side, "takenAt" DESC)`,
            { bind: [before] }
        );
    }
}
