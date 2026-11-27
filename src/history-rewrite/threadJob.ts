import { QueryTypes, type Sequelize, type Transaction } from 'sequelize';
import { TABLES } from '../addons/db/schema';
import type { Tx } from './fluxerWrites';
import type { StoredRow } from './kvRows';
import type { KvRow, ReplyTarget } from './plan';
import type { DoneCopy } from './sources';
import {
    planThread,
    type FileMove,
    type ThreadCopy,
    type ThreadStats,
} from './threadPlan';

/** Threads handled per run at most (261 on 2026-11-27). */
export const MAX_THREADS = 2_000;
/** Rows read per thread at most: far above the largest thread's. */
const MAX_ROWS = 200_000;

const CHANNEL_TABLES = [
    'messages',
    'message_reactions',
    'channel_pins',
    'attachment_lookup',
    'attachment_decay_by_id',
    'attachment_decay_by_expiry',
    'messages_by_author_id_v2',
    'read_states',
    'channels',
    'channel_state',
    'channel_message_buckets',
    'channel_empty_buckets',
];
const THREAD_TABLES = [
    'thread_state',
    'thread_stats',
    'threads_by_parent',
    'active_threads_by_guild',
    'archived_threads_by_parent',
    'thread_members',
    'thread_members_by_user',
];

/** Every Fluxer row that names thread `oldId`, locked for the move. */
export async function threadRows(tx: Tx, oldId: string): Promise<StoredRow[]> {
    const rows = await tx.rows<StoredRow>(
        `SELECT table_name, partition_key, row_key, row_data, sort_id::text AS sort_id
         FROM fluxer_kv
         WHERE (table_name = ANY($2::text[]) AND row_data->'channel_id'->>'value' = $1)
            OR (table_name = ANY($3::text[]) AND row_data->'thread_id'->>'value' = $1)
            OR (table_name = 'messages' AND row_data->'message_reference'->'channel_id'->>'value' = $1)
            OR (table_name = 'channels' AND row_data->'last_message_id'->>'value' = $1)
            OR (table_name = 'user_guild_settings' AND strpos(row_data::text, $4) > 0)
         LIMIT $5 FOR UPDATE`,
        [oldId, CHANNEL_TABLES, THREAD_TABLES, `"${oldId}"`, MAX_ROWS]
    );
    const seen = new Set<string>();
    return rows.filter((r) => {
        const key = `${r.table_name}\u0000${r.row_key}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
    const value = row[key];
    if (typeof value !== 'string' || value === '')
        throw new Error(`rewrite: ${key} missing`);
    return value;
}

/** Bifrost's side of the thread move. */
export class BifrostThreads {
    constructor(private readonly db: Sequelize) {}

    /** Fluxer thread ID → its Discord thread's ID, for threads guild-sync made. */
    async threadMap(
        fluxerThreads: ReadonlySet<string>
    ): Promise<Map<string, string>> {
        const rows = await this.db.query<Row>(
            `SELECT DISTINCT "fluxerId", "discordId" FROM ${TABLES.objectMap}
             WHERE kind = 'thread' AND "fluxerId" IS NOT NULL AND "discordId" IS NOT NULL`,
            { type: QueryTypes.SELECT }
        );
        const map = new Map<string, string>();
        for (const r of rows) {
            const from = text(r, 'fluxerId');
            const to = text(r, 'discordId');
            if (fluxerThreads.has(from) && BigInt(to) < BigInt(from))
                map.set(from, to);
        }
        return map;
    }

    async copiesIn(fluxerThreadId: string): Promise<Map<string, ThreadCopy>> {
        const rows = await this.db.query<Row>(
            `SELECT h."fluxerMessageId", h."discordMessageId", a.raw
             FROM ${TABLES.historyMessages} h
             LEFT JOIN ${TABLES.archiveMessages} a ON a."messageId" = h."discordMessageId"
             WHERE h."fluxerTargetId" = $1 AND NOT h.native AND h."fluxerMessageId" IS NOT NULL
             LIMIT $2`,
            { bind: [fluxerThreadId, MAX_ROWS], type: QueryTypes.SELECT }
        );
        return new Map(
            rows.map((r) => [
                text(r, 'fluxerMessageId'),
                {
                    discordMessageId: text(r, 'discordMessageId'),
                    raw: r.raw ?? null,
                },
            ])
        );
    }

    async archived(discordMessageId: string): Promise<unknown> {
        const rows = await this.db.query<Row>(
            `SELECT raw FROM ${TABLES.archiveMessages} WHERE "messageId" = $1`,
            { bind: [discordMessageId], type: QueryTypes.SELECT }
        );
        return rows[0]?.raw ?? null;
    }

    /** Where each copied Discord message is once the threads have moved. */
    async replyTargets(
        threads: ReadonlyMap<string, string>
    ): Promise<Map<string, ReplyTarget>> {
        const history = await this.db.query<Row>(
            `SELECT "discordMessageId", "fluxerTargetId" FROM ${TABLES.historyMessages}
             WHERE "fluxerMessageId" IS NOT NULL`,
            { type: QueryTypes.SELECT }
        );
        const targets = new Map<string, ReplyTarget>();
        for (const r of history) {
            const channel = text(r, 'fluxerTargetId');
            const id = text(r, 'discordMessageId');
            targets.set(id, {
                fluxerChannelId: threads.get(channel) ?? channel,
                fluxerMessageId: id,
            });
        }
        return targets;
    }

    async emojis(): Promise<Map<string, string>> {
        const rows = await this.db.query<Row>(
            `SELECT "discordId", "fluxerId" FROM ${TABLES.objectMap}
             WHERE kind = 'emoji' AND state = 'active' AND "discordId" IS NOT NULL AND "fluxerId" IS NOT NULL`,
            { type: QueryTypes.SELECT }
        );
        return new Map(
            rows.map((r) => [text(r, 'discordId'), text(r, 'fluxerId')])
        );
    }

    /** Points bifrost's records at the moved thread and its moved copies. */
    async recordThread(
        oldId: string,
        newId: string,
        done: readonly DoneCopy[]
    ): Promise<void> {
        await this.db.transaction(async (transaction: Transaction) => {
            const run = (sql: string, bind: unknown[]) =>
                this.db.query(sql, {
                    bind,
                    transaction,
                    type: QueryTypes.UPDATE,
                });
            if (done.length > 0) {
                await run(
                    `UPDATE ${TABLES.historyMessages} h
                     SET "formerFluxerMessageId" = h."fluxerMessageId",
                         "fluxerMessageId" = h."discordMessageId", native = true,
                         "nativeReply" = d."nativeReply", "contentHash" = d."contentHash"
                     FROM jsonb_to_recordset($1::jsonb)
                       AS d("discordMessageId" text, "oldFluxerMessageId" text,
                            "nativeReply" boolean, "contentHash" text)
                     WHERE h."discordMessageId" = d."discordMessageId"
                       AND h."fluxerMessageId" = d."oldFluxerMessageId"`,
                    [JSON.stringify(done)]
                );
            }
            await run(
                `UPDATE ${TABLES.historyMessages} SET "fluxerTargetId" = $2 WHERE "fluxerTargetId" = $1`,
                [oldId, newId]
            );
            await run(
                `UPDATE ${TABLES.objectMap} SET "fluxerId" = $2 WHERE kind = 'thread' AND "fluxerId" = $1`,
                [oldId, newId]
            );
            await run(
                `UPDATE ${TABLES.historyJobs} SET "fluxerId" = $2 WHERE "fluxerId" = $1`,
                [oldId, newId]
            );
            await run(
                `UPDATE ${TABLES.threadMessages} SET "fluxerThreadId" = $2 WHERE "fluxerThreadId" = $1`,
                [oldId, newId]
            );
        });
    }

    /** Guild-sync takes a fresh Fluxer snapshot on its next cycle. */
    async dropFluxerSnapshots(): Promise<void> {
        await this.db.query(
            `DELETE FROM ${TABLES.snapshots} WHERE side = 'fluxer'`,
            {
                type: QueryTypes.DELETE,
            }
        );
    }
}

export interface ThreadFluxer {
    threadIds(): Promise<Set<string>>;
    webhookIds(): Promise<Set<string>>;
    /** True when a channel or thread already uses the ID. */
    taken(id: string): Promise<boolean>;
    transaction(work: (tx: Tx) => Promise<void>): Promise<void>;
    /** Lets Fluxer rebuild its forum post search for the guild. */
    clearThreadSearch(): Promise<void>;
}

export interface ThreadJobDeps {
    readonly bifrost: BifrostThreads;
    readonly fluxer: ThreadFluxer;
    readonly botUserId: string;
    readonly apply: boolean;
    readonly log: (line: string) => void;
    readonly now: () => Date;
}

export interface ThreadReport extends ThreadStats {
    threads: number;
    moved: number;
    files: number;
    skipped: Record<string, number>;
    oldThreadIds: string[];
}

/** Moves each guild-sync thread to its Discord ID, with its messages. */
export class ThreadJob {
    readonly fileMoves: FileMove[] = [];
    private readonly report: ThreadReport = {
        threads: 0,
        moved: 0,
        files: 0,
        messages: 0,
        copies: 0,
        nativeReplies: 0,
        reactions: 0,
        edited: 0,
        undated: 0,
        skipped: {},
        oldThreadIds: [],
    };

    constructor(private readonly deps: ThreadJobDeps) {}

    async run(): Promise<ThreadReport> {
        const { bifrost, fluxer } = this.deps;
        const threads = await bifrost.threadMap(await fluxer.threadIds());
        const targets = await bifrost.replyTargets(threads);
        const shared = {
            botUserId: this.deps.botUserId,
            webhookIds: await fluxer.webhookIds(),
            emojis: await bifrost.emojis(),
            replyTarget: (id: string) => targets.get(id) ?? null,
        };
        for (const [oldId, newId] of [...threads].slice(0, MAX_THREADS)) {
            this.report.threads++;
            try {
                await this.thread(oldId, newId, shared);
            } catch (error) {
                const reason =
                    error instanceof Error ? error.message : String(error);
                this.report.skipped[reason] =
                    (this.report.skipped[reason] ?? 0) + 1;
                if (this.deps.apply) throw error;
            }
        }
        if (this.deps.apply && this.report.moved > 0) {
            await fluxer.clearThreadSearch();
            await bifrost.dropFluxerSnapshots();
        }
        return this.report;
    }

    private async thread(
        oldId: string,
        newId: string,
        shared: Omit<
            Parameters<typeof planThread>[0],
            'oldId' | 'newId' | 'copies' | 'starterRaw' | 'rows' | 'now'
        >
    ): Promise<void> {
        const { bifrost, fluxer } = this.deps;
        if (await fluxer.taken(newId))
            throw new Error('new thread ID is taken');
        const copies = await bifrost.copiesIn(oldId);
        const starterRaw = await bifrost.archived(newId);
        let done: readonly DoneCopy[] = [];
        await fluxer.transaction(async (tx) => {
            const rows = await threadRows(tx, oldId);
            const plan = planThread({
                ...shared,
                oldId,
                newId,
                copies,
                starterRaw,
                rows,
                now: this.deps.now(),
            });
            this.count(plan.stats, plan.files);
            if (!this.deps.apply) return;
            await deleteRows(tx, plan.deletes);
            await insertStrict(tx, plan.inserts);
            done = plan.done;
        });
        if (!this.deps.apply) return;
        await bifrost.recordThread(oldId, newId, done);
        this.report.moved++;
        this.report.oldThreadIds.push(oldId);
        this.deps.log(`thread ${oldId} -> ${newId}: ${done.length} copies`);
    }

    private count(stats: ThreadStats, files: readonly FileMove[]): void {
        for (const key of Object.keys(stats) as (keyof ThreadStats)[]) {
            this.report[key] += stats[key];
        }
        this.report.files += files.length;
        this.fileMoves.push(...files);
    }
}

/** Inserts rows; an existing key fails the transaction, so nothing is lost. */
async function insertStrict(tx: Tx, rows: readonly KvRow[]): Promise<void> {
    const BATCH = 2_000;
    for (let i = 0; i < rows.length; i += BATCH) {
        const records = rows.slice(i, i + BATCH).map((r) => ({
            t: r.tableName,
            p: r.partitionKey,
            k: r.rowKey,
            d: r.rowData,
            s: r.sortId,
        }));
        await tx.run(
            `INSERT INTO fluxer_kv (table_name, partition_key, row_key, row_data, sort_id, updated_at)
             SELECT r.t, r.p, r.k, r.d, r.s::bigint, now()
             FROM jsonb_to_recordset($1::jsonb) AS r(t text, p text, k text, d jsonb, s text)`,
            [JSON.stringify(records)]
        );
    }
}

async function deleteRows(
    tx: Tx,
    rows: readonly { table: string; key: string }[]
): Promise<void> {
    if (rows.length === 0) return;
    await tx.run(
        `DELETE FROM fluxer_kv kv USING jsonb_to_recordset($1::jsonb) AS d("table" text, "key" text)
         WHERE kv.table_name = d."table" AND kv.row_key = d."key"`,
        [JSON.stringify(rows)]
    );
}

/** Fluxer queries for the thread job, on the owner's connection. */
export function threadFluxer(
    db: Sequelize,
    tx: (t: Transaction) => Tx
): ThreadFluxer {
    const rows = <T extends object>(sql: string, bind: unknown[] = []) =>
        db.query<T>(sql, { bind, type: QueryTypes.SELECT });
    return {
        threadIds: async () =>
            new Set(
                (
                    await rows<{ id: string }>(
                        `SELECT row_data->'thread_id'->>'value' AS id FROM fluxer_kv WHERE table_name = 'thread_state'`
                    )
                ).map((r) => r.id)
            ),
        webhookIds: async () =>
            new Set(
                (
                    await rows<{ id: string }>(
                        `SELECT row_data->'webhook_id'->>'value' AS id FROM fluxer_kv WHERE table_name = 'webhooks'`
                    )
                ).map((r) => r.id)
            ),
        taken: async (id) =>
            (
                await rows<{ n: number }>(
                    `SELECT count(*)::int AS n FROM fluxer_kv
                     WHERE table_name IN ('channels', 'thread_state', 'channel_state')
                       AND (row_data->'channel_id'->>'value' = $1 OR row_data->'thread_id'->>'value' = $1)`,
                    [id]
                )
            )[0]?.n !== 0,
        transaction: (work) => db.transaction((t) => work(tx(t))),
        clearThreadSearch: async () => {
            await db.query(
                `UPDATE fluxer_kv SET row_data = row_data - 'search_backfilled_at', updated_at = now()
                 WHERE table_name = 'guild_thread_state'`
            );
        },
    };
}
