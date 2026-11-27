import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DataTypes, QueryTypes, Sequelize } from 'sequelize';
import { runAddonMigrations } from '../../src/addons/db/migrator';
import { TABLES } from '../../src/addons/db/schema';
import { bigintValue, bucketOf } from '../../src/fluxer-db/keys';
import { keyFrom, primaryKey } from '../../src/history-rewrite/kvRows';
import {
    BifrostThreads,
    ThreadJob,
    threadFluxer,
} from '../../src/history-rewrite/threadJob';
import { createRecordingLogger } from '../addons/fakes';

/** Moving a forum post to its Discord ID, on Postgres. */
const url = process.env.BF_TEST_POSTGRES_URL;
const FLUXER = 'bifrost_test_threads_fluxer';
const BIFROST = 'bifrost_test_threads_bifrost';
const EPOCH = BigInt(1_420_070_400_000);
const idAt = (iso: string, n = 0) =>
    (((BigInt(Date.parse(iso)) - EPOCH) << BigInt(22)) + BigInt(n)).toString();

const GUILD = '1564288093618438144';
const PARENT = '1575323110188515328';
const WEBHOOK = '1575407231271174147';
const BOT = '1565044763378319360';
const USER = '1564283596645072896';
const OLD = '1575348674089713664';
const COPY_OLD = '1575348674089713700';
const PIN_MSG = '1575348674089713800';
const NEW = idAt('2019-05-01T10:00:00Z');
const COPY_NEW = idAt('2019-05-01T10:05:00Z');
const GUILD_LINK = '00000000-0000-4000-8000-000000000001';
const JOB = '00000000-0000-4000-8000-000000000002';
const big = bigintValue;
const date = (value: string) => ({ __fluxer_type: 'date', value });

function databaseUrl(base: string, name: string): string {
    const parsed = new URL(base);
    parsed.pathname = `/${name}`;
    return parsed.toString();
}

async function freshDatabase(name: string): Promise<Sequelize> {
    const admin = new Sequelize(url ?? '', { logging: false });
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.close();
    return new Sequelize(databaseUrl(url ?? '', name), { logging: false });
}

/** Inserts a row keyed as Fluxer keys it; `parts` is the partition's length. */
async function kv(
    db: Sequelize,
    table: string,
    data: Record<string, unknown>,
    parts?: number
) {
    const columns =
        table === 'webhooks' || table === 'guild_thread_state'
            ? [Object.keys(data)[0] ?? '']
            : primaryKey(table);
    const key = keyFrom(data, columns);
    const partition = parts
        ? key.split('\u001f').slice(0, parts).join('\u001f')
        : key;
    const id = (data.message_id as { value?: string } | undefined)?.value;
    const sort =
        table === 'messages' || table === 'message_reactions' ? id : null;
    await db.query(
        `INSERT INTO fluxer_kv (table_name, partition_key, row_key, row_data, sort_id) VALUES ($1, $2, $3, $4::jsonb, $5::bigint)`,
        { bind: [table, partition, key, JSON.stringify(data), sort ?? null] }
    );
}

const message = (
    channel: string,
    id: string,
    fields: Record<string, unknown> = {}
) => ({
    type: 0,
    flags: 0,
    version: 1,
    bucket: bucketOf(id),
    channel_id: big(channel),
    message_id: big(id),
    has_reaction: false,
    ...fields,
});

async function seedFluxer(db: Sequelize): Promise<void> {
    await db.query('TRUNCATE fluxer_kv');
    await kv(db, 'webhooks', {
        webhook_id: big(WEBHOOK),
        channel_id: big(PARENT),
    });
    await kv(db, 'guild_thread_state', {
        guild_id: big(GUILD),
        search_backfilled_at: date('2026-10-26T17:40:43.534Z'),
    });
    await kv(db, 'channels', {
        channel_id: big(OLD),
        soft_deleted: false,
        type: 11,
        parent_id: big(PARENT),
        owner_id: big(WEBHOOK),
        last_message_id: big(PIN_MSG),
        indexed_at: date('2026-11-26T00:00:00Z'),
    });
    await kv(db, 'channels', {
        channel_id: big(PARENT),
        soft_deleted: false,
        type: 15,
        last_message_id: big(OLD),
    });
    await kv(db, 'thread_state', {
        thread_id: big(OLD),
        parent_id: big(PARENT),
        guild_id: big(GUILD),
        archived: true,
        archive_timestamp: date('2026-11-26T04:51:57.828Z'),
        has_starter: true,
    });
    await kv(db, 'thread_stats', { thread_id: big(OLD), message_count: 2 });
    await kv(
        db,
        'threads_by_parent',
        {
            parent_id: big(PARENT),
            thread_id: big(OLD),
            guild_id: big(GUILD),
            type: 11,
        },
        1
    );
    await kv(
        db,
        'archived_threads_by_parent',
        {
            parent_id: big(PARENT),
            is_private: false,
            archive_timestamp: date('2026-11-26T04:51:57.828Z'),
            thread_id: big(OLD),
            guild_id: big(GUILD),
        },
        2
    );
    await kv(
        db,
        'thread_members',
        {
            thread_id: big(OLD),
            user_id: big(BOT),
            guild_id: big(GUILD),
            parent_id: big(PARENT),
        },
        1
    );
    await kv(db, 'channel_state', {
        channel_id: big(OLD),
        created_bucket: bucketOf(OLD),
        last_message_id: big(PIN_MSG),
        last_message_bucket: bucketOf(PIN_MSG),
        has_messages: true,
    });
    await kv(
        db,
        'channel_message_buckets',
        {
            channel_id: big(OLD),
            bucket: bucketOf(OLD),
            updated_at: date('2026-11-26T00:00:00Z'),
        },
        1
    );
    await kv(
        db,
        'messages',
        message(OLD, OLD, {
            webhook_id: big(WEBHOOK),
            webhook_name: 'Jake',
            content: 'post body\n*Originally posted 2019-05-01 10:00 UTC*',
        }),
        2
    );
    await kv(
        db,
        'messages',
        message(OLD, COPY_OLD, {
            webhook_id: big(WEBHOOK),
            webhook_name: 'Jake',
            content:
                'reply\nReactions: 👍 2\n*Originally posted 2019-05-01 10:05 UTC*',
            embeds: [{ color: 0x0b0d0e, author: { name: 'jake ↩️' } }],
            attachments: [
                {
                    attachment_id: big('1575325732261855235'),
                    filename: 'a.png',
                },
            ],
        }),
        2
    );
    await kv(
        db,
        'messages',
        message(OLD, PIN_MSG, { type: 6, author_id: big(BOT), content: '' }),
        2
    );
    await kv(
        db,
        'message_reactions',
        {
            channel_id: big(OLD),
            bucket: bucketOf(COPY_OLD),
            message_id: big(COPY_OLD),
            emoji_id: big('0'),
            emoji_name: '🎉',
            user_id: big(BOT),
            emoji_animated: false,
        },
        2
    );
    await kv(db, 'channel_pins', {
        channel_id: big(OLD),
        pinned_timestamp: date('2026-11-26T18:15:10.978Z'),
        message_id: big(COPY_OLD),
    });
    await kv(db, 'attachment_lookup', {
        channel_id: big(OLD),
        attachment_id: big('1575325732261855235'),
        filename: 'a.png',
        message_id: big(COPY_OLD),
    });
    await kv(db, 'attachment_decay_by_id', {
        attachment_id: big('1575325732261855235'),
        channel_id: big(OLD),
        message_id: big(COPY_OLD),
        filename: 'a.png',
    });
    await kv(db, 'messages_by_author_id_v2', {
        author_id: big(BOT),
        message_id: big(PIN_MSG),
        channel_id: big(OLD),
    });
    await kv(db, 'read_states', {
        user_id: big(USER),
        channel_id: big(OLD),
        message_id: big(COPY_OLD),
        mention_count: 0,
    });
    await kv(
        db,
        'messages',
        message(PARENT, '1575348674089713664', {
            type: 18,
            message_reference: {
                type: 0,
                guild_id: null,
                channel_id: big(OLD),
                message_id: null,
            },
        }),
        2
    );
}

async function seedBifrost(db: Sequelize): Promise<void> {
    await db.query(
        `TRUNCATE ${TABLES.historyMessages}, ${TABLES.historyJobs}, ${TABLES.archiveMessages}, ${TABLES.objectMap}, ${TABLES.snapshots} CASCADE`
    );
    await db.query(
        `INSERT INTO ${TABLES.objectMap} (id, "guildLinkId", kind, "discordId", "fluxerId", state, "missingCount", "createdBySync", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, 'thread', $2, $3, 'active', 0, true, now(), now())`,
        { bind: [GUILD_LINK, NEW, OLD] }
    );
    await db.query(
        `INSERT INTO ${TABLES.historyJobs} (id, "guildLinkId", kind, "discordId", "fluxerId", status, "createdAt", "updatedAt")
         VALUES ($1, $2, 'thread', $3, $4, 'done', now(), now())`,
        { bind: [JOB, GUILD_LINK, NEW, OLD] }
    );
    await db.query(
        `INSERT INTO ${TABLES.historyMessages} ("discordMessageId", "jobId", "discordAuthorId", "fluxerMessageId", "fluxerTargetId", "inThread", "webhookId", "createdAt")
         VALUES ($1, $2, '500', $3, $4, true, $5, now())`,
        { bind: [COPY_NEW, JOB, COPY_OLD, OLD, WEBHOOK] }
    );
    const raws: [string, object][] = [
        [
            COPY_NEW,
            {
                type: 19,
                message_reference: { message_id: NEW },
                reactions: [{ emoji: { id: null, name: '👍' }, count: 2 }],
            },
        ],
        [
            NEW,
            {
                type: 0,
                edited_timestamp: '2019-05-01T10:01:00+00:00',
                reactions: [],
            },
        ],
    ];
    for (const [id, raw] of raws) {
        await db.query(
            `INSERT INTO ${TABLES.archiveMessages} ("messageId", "channelId", "guildId", "authorId", "createdAt", raw, redacted, "fetchedAt")
             VALUES ($1, $2, '100', '500', now(), $3::jsonb, false, now())`,
            { bind: [id, NEW, JSON.stringify(raw)] }
        );
    }
}

async function rows(db: Sequelize, sql: string, bind: unknown[] = []) {
    return db.query<Record<string, unknown>>(sql, {
        bind,
        type: QueryTypes.SELECT,
    });
}

describe('thread rewrite on Postgres', { skip: !url }, () => {
    let fluxer: Sequelize;
    let bifrost: Sequelize;

    before(async () => {
        fluxer = await freshDatabase(FLUXER);
        await fluxer.query(`CREATE TABLE fluxer_kv (
            table_name text NOT NULL, partition_key text COLLATE "C" NOT NULL,
            row_key text COLLATE "C" NOT NULL, row_data jsonb NOT NULL,
            expires_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
            sort_id bigint, PRIMARY KEY (table_name, row_key))`);
        bifrost = await freshDatabase(BIFROST);
        const qi = bifrost.getQueryInterface();
        await qi.createTable('guild_links', {
            id: { type: DataTypes.UUID, primaryKey: true },
            createdAt: { type: DataTypes.DATE, allowNull: false },
        });
        await qi.createTable('channel_links', {
            id: { type: DataTypes.UUID, primaryKey: true },
        });
        await qi.createTable('message_links', {
            id: { type: DataTypes.UUID, primaryKey: true },
        });
        await bifrost.query(
            `INSERT INTO guild_links (id, "createdAt") VALUES ($1, now())`,
            { bind: [GUILD_LINK] }
        );
        await runAddonMigrations(bifrost, createRecordingLogger());
    });

    beforeEach(async () => {
        await seedFluxer(fluxer);
        await seedBifrost(bifrost);
    });

    after(async () => {
        await fluxer.close();
        await bifrost.close();
    });

    const job = (apply: boolean) =>
        new ThreadJob({
            bifrost: new BifrostThreads(bifrost),
            fluxer: threadFluxer(fluxer, (t) => ({
                rows: <T extends object>(
                    sql: string,
                    bind: readonly unknown[]
                ) =>
                    fluxer.query<T>(sql, {
                        bind: [...bind],
                        type: QueryTypes.SELECT,
                        transaction: t,
                    }),
                run: async (sql, bind) => {
                    await fluxer.query(sql, {
                        bind: [...bind],
                        transaction: t,
                    });
                },
            })),
            botUserId: BOT,
            apply,
            log: () => {},
            now: () => new Date('2026-11-27T12:00:00Z'),
        });

    it('plans the move and the file copies without writing', async () => {
        const dry = job(false);
        const report = await dry.run();
        assert.deepEqual(
            [report.threads, report.moved, report.copies, report.messages],
            [1, 0, 1, 3]
        );
        assert.deepEqual(dry.fileMoves, [
            {
                from: `attachments/${OLD}/1575325732261855235/a.png`,
                to: `attachments/${NEW}/1575325732261855235/a.png`,
            },
        ]);
        const left = await rows(
            fluxer,
            `SELECT 1 FROM fluxer_kv WHERE table_name = 'thread_state' AND row_data->'thread_id'->>'value' = $1`,
            [OLD]
        );
        assert.equal(left.length, 1);
    });

    it('moves the thread, its messages and every row that names it', async () => {
        const report = await job(true).run();
        assert.deepEqual(
            [report.moved, report.nativeReplies, report.edited, report.undated],
            [1, 1, 1, 0]
        );

        const stale = await rows(
            fluxer,
            `SELECT table_name FROM fluxer_kv WHERE row_data::text LIKE $1`,
            [`%"${OLD}"%`]
        );
        assert.deepEqual(
            stale.map((r) => r.table_name).sort(),
            ['messages'],
            'only the parent message whose own ID equals OLD'
        );

        const [channel] = await rows(
            fluxer,
            `SELECT row_data FROM fluxer_kv WHERE table_name = 'channels' AND row_data->'channel_id'->>'value' = $1`,
            [NEW]
        );
        const data = channel?.row_data as Record<
            string,
            { value?: string } | null
        >;
        assert.equal(data.owner_id?.value, BOT);
        assert.equal(data.last_message_id?.value, PIN_MSG);
        assert.equal(data.indexed_at, null);

        const msgs = await rows(
            fluxer,
            `SELECT row_data->'message_id'->>'value' AS id, row_data->>'content' AS content, sort_id::text AS sort, row_data->'message_reference'->'message_id'->>'value' AS ref, jsonb_array_length(COALESCE(row_data->'embeds','[]')) AS embeds FROM fluxer_kv WHERE table_name = 'messages' AND row_data->'channel_id'->>'value' = $1 ORDER BY sort_id`,
            [NEW]
        );
        assert.deepEqual(msgs, [
            { id: NEW, content: 'post body', sort: NEW, ref: null, embeds: 0 },
            {
                id: COPY_NEW,
                content: 'reply',
                sort: COPY_NEW,
                ref: NEW,
                embeds: 0,
            },
            { id: PIN_MSG, content: '', sort: PIN_MSG, ref: null, embeds: 0 },
        ]);

        const state = await rows(
            fluxer,
            `SELECT (row_data->>'created_bucket')::int AS created, row_data->'last_message_id'->>'value' AS last FROM fluxer_kv WHERE table_name = 'channel_state'`
        );
        assert.deepEqual(state, [{ created: bucketOf(NEW), last: PIN_MSG }]);
        const buckets = await rows(
            fluxer,
            `SELECT (row_data->>'bucket')::int AS b FROM fluxer_kv WHERE table_name = 'channel_message_buckets' ORDER BY 1`
        );
        assert.deepEqual(
            buckets.map((b) => b.b),
            [
                ...new Set([
                    bucketOf(NEW),
                    bucketOf(COPY_NEW),
                    bucketOf(PIN_MSG),
                ]),
            ].sort((a, b) => a - b)
        );

        const reactions = await rows(
            fluxer,
            `SELECT row_data->>'emoji_name' AS e, row_data->'message_id'->>'value' AS m FROM fluxer_kv WHERE table_name = 'message_reactions' ORDER BY 1`
        );
        assert.deepEqual(reactions, [
            { e: '🎉', m: COPY_NEW },
            { e: '👍', m: COPY_NEW },
        ]);
        for (const table of [
            'channel_pins',
            'attachment_lookup',
            'attachment_decay_by_id',
            'read_states',
        ]) {
            const [row] = await rows(
                fluxer,
                `SELECT row_data->'channel_id'->>'value' AS c, row_data->'message_id'->>'value' AS m FROM fluxer_kv WHERE table_name = $1`,
                [table]
            );
            assert.deepEqual(row, { c: NEW, m: COPY_NEW }, table);
        }
        const [parentRef] = await rows(
            fluxer,
            `SELECT row_data->'message_reference'->'channel_id'->>'value' AS c FROM fluxer_kv WHERE table_name = 'messages' AND (row_data->>'type')::int = 18`
        );
        assert.equal(parentRef?.c, NEW);
        const [search] = await rows(
            fluxer,
            `SELECT row_data ? 'search_backfilled_at' AS has FROM fluxer_kv WHERE table_name = 'guild_thread_state'`
        );
        assert.equal(search?.has, false);

        const [map] = await rows(
            bifrost,
            `SELECT "fluxerId" FROM ${TABLES.objectMap} WHERE kind = 'thread'`
        );
        assert.equal(map?.fluxerId, NEW);
        const [copy] = await rows(
            bifrost,
            `SELECT "fluxerMessageId", "fluxerTargetId", native, "nativeReply" FROM ${TABLES.historyMessages}`
        );
        assert.deepEqual(copy, {
            fluxerMessageId: COPY_NEW,
            fluxerTargetId: NEW,
            native: true,
            nativeReply: true,
        });
    });

    it('finds nothing left to move on a second run', async () => {
        await job(true).run();
        const again = await job(true).run();
        assert.equal(again.threads, 0);
    });
});
