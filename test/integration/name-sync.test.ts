import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { DataTypes, QueryTypes, Sequelize } from 'sequelize';
import { runAddonMigrations } from '../../src/addons/db/migrator';
import { TABLES } from '../../src/addons/db/schema';
import {
    bigintValue,
    messagePartitionKey,
    messageRowKey,
} from '../../src/fluxer-db/keys';
import { PostgresNameStore } from '../../src/name-sync/store';
import { FluxerNameWriter } from '../../src/name-sync/writer';
import { createRecordingLogger } from '../addons/fakes';

/** Name sync's SQL on Postgres: its store, and the Fluxer-side function. */
const url = process.env.BF_TEST_POSTGRES_URL;
const BIFROST = 'bifrost_test_names_bifrost';
const FLUXER = 'bifrost_test_names_fluxer';
const GUILD_LINK = '00000000-0000-4000-8000-000000000001';
const JOB = '00000000-0000-4000-8000-000000000002';
const CHANNEL_LINK = '00000000-0000-4000-8000-000000000003';

function databaseUrl(base: string, name: string): string {
    const parsed = new URL(base);
    parsed.pathname = `/${name}`;
    return parsed.toString();
}

async function freshDatabase(name: string): Promise<Sequelize> {
    const admin = new Sequelize(url ?? '', { logging: false });
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.query(
        `DO $$ BEGIN CREATE ROLE bifrost_bridge NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`
    );
    await admin.close();
    return new Sequelize(databaseUrl(url ?? '', name), { logging: false });
}

/** deploy/fluxer-bridge.sql without its psql-only role statements. */
function bridgeFunctions(): string {
    const sql = readFileSync('deploy/fluxer-bridge.sql', 'utf8');
    return sql.slice(sql.indexOf('CREATE SCHEMA'));
}

describe('name sync on Postgres', { skip: !url }, () => {
    let bifrost: Sequelize;
    let fluxer: Sequelize;

    before(async () => {
        bifrost = await freshDatabase(BIFROST);
        const qi = bifrost.getQueryInterface();
        await qi.createTable('guild_links', {
            id: { type: DataTypes.UUID, primaryKey: true },
            createdAt: { type: DataTypes.DATE, allowNull: false },
        });
        await qi.createTable('channel_links', {
            id: { type: DataTypes.UUID, primaryKey: true },
            guildLinkId: { type: DataTypes.UUID },
            fluxerChannelId: { type: DataTypes.STRING },
            fluxerWebhookId: { type: DataTypes.STRING },
            fluxerWebhookToken: { type: DataTypes.STRING },
        });
        await qi.createTable('message_links', {
            id: { type: DataTypes.UUID, primaryKey: true },
            guildLinkId: { type: DataTypes.UUID },
            channelLinkId: { type: DataTypes.UUID },
            discordMessageId: { type: DataTypes.STRING },
            fluxerMessageId: { type: DataTypes.STRING },
        });
        await bifrost.query(
            `INSERT INTO guild_links (id, "createdAt") VALUES ($1, now())`,
            { bind: [GUILD_LINK] }
        );
        await runAddonMigrations(bifrost, createRecordingLogger());
        await bifrost.query(
            `INSERT INTO channel_links (id, "guildLinkId", "fluxerChannelId", "fluxerWebhookId", "fluxerWebhookToken")
             VALUES ($1, $2, '300', '7', 'bridge-token')`,
            { bind: [CHANNEL_LINK, GUILD_LINK] }
        );
        await bifrost.query(
            `INSERT INTO ${TABLES.historyJobs} (id, "guildLinkId", kind, "discordId", status, "importWebhookId", "importWebhookToken", "createdAt", "updatedAt")
             VALUES ($1, $2, 'channel', '200', 'done', '8', 'import-token', now(), now())`,
            { bind: [JOB, GUILD_LINK] }
        );
        await bifrost.query(
            `INSERT INTO ${TABLES.historyMessages} ("discordMessageId", "jobId", "discordAuthorId", "fluxerMessageId", "fluxerTargetId", "inThread", "webhookId", "createdAt")
             VALUES ('11', $1, '500', '1011', '300', false, '8', now()), ('12', $1, '500', '1012', '300', false, '7', now())`,
            { bind: [JOB] }
        );
        await bifrost.query(
            `INSERT INTO message_links (id, "guildLinkId", "channelLinkId", "discordMessageId", "fluxerMessageId")
             VALUES ('00000000-0000-4000-8000-000000000004', $1, $2, '13', '1013')`,
            { bind: [GUILD_LINK, CHANNEL_LINK] }
        );
        await bifrost.query(
            `INSERT INTO ${TABLES.archiveMessages} ("messageId", "channelId", "guildId", "authorId", "createdAt", raw, redacted, "fetchedAt")
             VALUES ('13', '200', '100', '500', now(), '{}'::jsonb, false, now())`
        );

        fluxer = await freshDatabase(FLUXER);
        await fluxer.query(`
            CREATE TABLE fluxer_kv (
                table_name text NOT NULL, partition_key text COLLATE "C" NOT NULL,
                row_key text COLLATE "C" NOT NULL, row_data jsonb NOT NULL,
                expires_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
                sort_id bigint, PRIMARY KEY (table_name, row_key))`);
        await fluxer.query(bridgeFunctions());
    });

    after(async () => {
        await bifrost.close();
        await fluxer.close();
    });

    it('finds every copy of an author, with the token of the webhook that sent it', async () => {
        const store = new PostgresNameStore(bifrost);
        const copies = await store.copies(GUILD_LINK, '500');
        const byId = Object.fromEntries(
            copies.map((c) => [c.messageId, c.webhookToken])
        );
        assert.deepEqual(byId, {
            '1011': 'import-token',
            '1012': 'bridge-token',
            '1013': 'bridge-token',
        });
    });

    it('finds the archived names of a member', async () => {
        const store = new PostgresNameStore(bifrost);
        await bifrost.query(
            `INSERT INTO ${TABLES.archiveMembers} ("guildId", "userId", username, "globalName", nick, avatar, "serverAvatar", "inGuild", "seenAt")
             VALUES ('100', '600', 'old', 'Old Name', null, null, null, false, now())`
        );
        assert.deepEqual(await store.archivedNames('100', '600'), {
            nick: null,
            globalName: 'Old Name',
            username: 'old',
        });
        assert.equal(await store.archivedNames('100', '601'), null);
        await bifrost.query(
            `INSERT INTO ${TABLES.archiveMessages} ("messageId", "channelId", "guildId", "authorId", "createdAt", raw, redacted, "fetchedAt")
             VALUES ('14', '200', '100', '602', now(), $1::jsonb, false, now())`,
            {
                bind: [
                    JSON.stringify({
                        author: {
                            id: '602',
                            username: 'Deleted User',
                            global_name: null,
                        },
                    }),
                ],
            }
        );
        assert.deepEqual(await store.archivedNames('100', '602'), {
            nick: null,
            globalName: null,
            username: 'Deleted User',
        });
    });

    it("lowers a channel's search bound only when it is above the bucket", async () => {
        const key = (id: string) =>
            `{"__fluxer_type":"bigint","value":"${id}"}`;
        for (const [id, bucket] of [
            ['950', 434],
            ['951', 100],
        ] as const) {
            await fluxer.query(
                `INSERT INTO fluxer_kv (table_name, partition_key, row_key, row_data) VALUES ('channel_state', $1, $1, $2::jsonb)`,
                {
                    bind: [
                        key(id),
                        JSON.stringify({
                            channel_id: bigintValue(id),
                            created_bucket: bucket,
                        }),
                    ],
                }
            );
        }
        const writer = new FluxerNameWriter({
            rows: <T extends object>(sql: string, bind: readonly unknown[]) =>
                fluxer.query<T>(sql, {
                    bind: [...bind],
                    type: QueryTypes.SELECT,
                }),
        });
        // 573091117793280000 is in bucket 158.
        const oldest = new Map([
            ['950', '573091117793280000'],
            ['951', '573091117793280000'],
        ]);
        assert.equal(await writer.lowerBuckets(oldest), 1);
        assert.equal(await writer.lowerBuckets(oldest), 0);
        const rows = await fluxer.query<{ id: string; b: number }>(
            `SELECT row_data->'channel_id'->>'value' AS id, (row_data->>'created_bucket')::int AS b
             FROM fluxer_kv WHERE table_name = 'channel_state' ORDER BY 1`,
            { type: QueryTypes.SELECT }
        );
        assert.deepEqual(rows, [
            { id: '950', b: 158 },
            { id: '951', b: 100 },
        ]);
        await fluxer.query(
            `DELETE FROM fluxer_kv WHERE table_name = 'channel_state'`
        );
    });

    it("retries authors that ran out of tries, and finds each channel's oldest moved copy", async () => {
        const store = new PostgresNameStore(bifrost);
        await bifrost.query(
            `INSERT INTO ${TABLES.nameSync} ("guildId", "discordUserId", dirty, failures) VALUES ('100', '700', false, 5)`
        );
        await store.retryFailed();
        const [row] = await bifrost.query<{ dirty: boolean; failures: number }>(
            `SELECT dirty, failures FROM ${TABLES.nameSync} WHERE "discordUserId" = '700'`,
            { type: QueryTypes.SELECT }
        );
        assert.deepEqual(row, { dirty: true, failures: 0 });
        await bifrost.query(
            `UPDATE ${TABLES.historyMessages} SET native = true WHERE "discordMessageId" IN ('11', '12')`
        );
        assert.deepEqual([...(await store.oldestNative(10))], [['300', '11']]);
        await bifrost.query(
            `DELETE FROM ${TABLES.nameSync} WHERE "discordUserId" = '700'`
        );
        await bifrost.query(
            `UPDATE ${TABLES.historyMessages} SET native = false`
        );
    });

    it('seeds authors once, and tracks what was applied', async () => {
        const store = new PostgresNameStore(bifrost);
        await store.seed('100', GUILD_LINK);
        await store.seed('100', GUILD_LINK);
        assert.deepEqual(await store.due('100', 10), [
            { discordUserId: '500', appliedName: null },
        ]);
        await store.applied('100', '500', 'Jake', new Date());
        assert.deepEqual(await store.due('100', 10), []);
        await store.markDirty('500');
        assert.deepEqual(await store.due('100', 10), [
            { discordUserId: '500', appliedName: 'Jake' },
        ]);
    });

    it('renames only webhook copies without a user author', async () => {
        const row = (id: string, fields: object) => ({
            channel_id: bigintValue('300'),
            message_id: bigintValue(id),
            webhook_name: 'Old',
            ...fields,
        });
        const rows = [
            ['1011', row('1011', { webhook_id: bigintValue('8') })],
            [
                '1012',
                row('1012', {
                    webhook_id: bigintValue('7'),
                    author_id: bigintValue('9'),
                }),
            ],
            ['1013', row('1013', {})],
        ] as const;
        for (const [id, data] of rows) {
            await fluxer.query(
                `INSERT INTO fluxer_kv (table_name, partition_key, row_key, row_data) VALUES ('messages', $1, $2, $3::jsonb)`,
                {
                    bind: [
                        messagePartitionKey('300', id),
                        messageRowKey('300', id),
                        JSON.stringify(data),
                    ],
                }
            );
        }
        const writer = new FluxerNameWriter({
            rows: <T extends object>(sql: string, bind: readonly unknown[]) =>
                fluxer.query<T>(sql, {
                    bind: [...bind],
                    type: QueryTypes.SELECT,
                }),
        });
        await writer.check();
        const copies = ['1011', '1012', '1013'].map((id) => ({
            channelId: '300',
            messageId: id,
            webhookId: null,
            webhookToken: null,
        }));
        assert.equal(await writer.rename(copies, 'Jake'), 1);
        assert.equal(await writer.rename(copies, 'Jake'), 0);
        const names = await fluxer.query<{ id: string; name: string }>(
            `SELECT row_data->'message_id'->>'value' AS id, row_data->>'webhook_name' AS name FROM fluxer_kv ORDER BY 1`,
            { type: QueryTypes.SELECT }
        );
        assert.deepEqual(
            names.map((n) => n.name),
            ['Jake', 'Old', 'Old']
        );
        await assert.rejects(writer.rename(copies, ''));
    });

    it("gives webhook-owned threads to the bot and leaves people's threads alone", async () => {
        const insert = (table: string, key: string, data: object) =>
            fluxer.query(
                `INSERT INTO fluxer_kv (table_name, partition_key, row_key, row_data) VALUES ($1, $2, $2, $3::jsonb)`,
                { bind: [table, key, JSON.stringify(data)] }
            );
        await insert('webhooks', 'w7', { webhook_id: bigintValue('7') });
        await insert('channels', 't1', {
            channel_id: bigintValue('901'),
            type: 11,
            owner_id: bigintValue('7'),
        });
        await insert('channels', 't2', {
            channel_id: bigintValue('902'),
            type: 11,
            owner_id: bigintValue('55'),
        });
        await insert('channels', 'c1', {
            channel_id: bigintValue('903'),
            type: 0,
            owner_id: bigintValue('7'),
        });
        const writer = new FluxerNameWriter({
            rows: <T extends object>(sql: string, bind: readonly unknown[]) =>
                fluxer.query<T>(sql, {
                    bind: [...bind],
                    type: QueryTypes.SELECT,
                }),
        });
        assert.equal(await writer.giveWebhookThreads('1565044763378319360'), 1);
        assert.equal(await writer.giveWebhookThreads('1565044763378319360'), 0);
        const owners = await fluxer.query<{ id: string; owner: string }>(
            `SELECT row_data->'channel_id'->>'value' AS id, row_data->'owner_id'->>'value' AS owner
             FROM fluxer_kv WHERE table_name = 'channels' ORDER BY 1`,
            { type: QueryTypes.SELECT }
        );
        assert.deepEqual(
            owners.map((o) => o.owner),
            ['1565044763378319360', '55', '7']
        );
    });
});
