import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Sequelize } from 'sequelize';
import { runAddonMigrations } from '../../src/addons/db/migrator';
import { TABLES } from '../../src/addons/db/schema';
import { SqlCatchUpStore } from '../../src/relay-extras/catchUp/store';
import { createRecordingLogger } from '../addons/fakes';
import { idAt, NOW } from '../relay-extras/catch-up-fakes';
import {
    CHANNEL_LINK,
    GUILD_LINK,
    prepareUpstream,
    upstreamCases,
} from '../relay-extras/catch-up-store-cases';

/**
 * Catch-up's reads on a real Postgres (BF_TEST_POSTGRES_URL), in its own
 * database: upstream's tables, then the history add-on's.
 */
const url = process.env.BF_TEST_POSTGRES_URL;
const DATABASE = 'bifrost_test_catch_up';

function databaseUrl(base: string, name: string): string {
    const parsed = new URL(base);
    parsed.pathname = `/${name}`;
    return parsed.toString();
}

const HISTORY_DISCORD = idAt(NOW - 200 * 3_600_000);
const HISTORY_FLUXER = idAt(NOW - 200 * 3_600_000, 3);

async function seedHistory(db: Sequelize): Promise<void> {
    const jobId = randomUUID();
    await db.query(
        `INSERT INTO ${TABLES.historyJobs} (id, "guildLinkId", kind, "discordId", status, "createdAt", "updatedAt")
         VALUES ($1, $2, 'channel', 'dc-1', 'done', now(), now())`,
        { bind: [jobId, GUILD_LINK] }
    );
    await db.query(
        `INSERT INTO ${TABLES.historyMessages} ("discordMessageId", "jobId", "discordAuthorId", "fluxerMessageId", "fluxerTargetId", "inThread", "webhookId", "createdAt")
         VALUES ('5', $1, 'a', '6', 'fc-1', false, 'w', now()),
                ($2, $1, 'a', $3, 'fc-1', false, 'w', now()),
                ('7', $1, 'a', NULL, 'fc-1', false, 'w', now())`,
        { bind: [jobId, HISTORY_DISCORD, HISTORY_FLUXER] }
    );
}

describe('SqlCatchUpStore on Postgres', { skip: !url }, () => {
    let db: Sequelize;

    before(async () => {
        const admin = new Sequelize(url ?? '', { logging: false });
        await admin.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
        await admin.query(`CREATE DATABASE ${DATABASE}`);
        await admin.close();
        db = new Sequelize(databaseUrl(url ?? '', DATABASE), {
            logging: false,
        });
        await prepareUpstream(db);
        await runAddonMigrations(db, createRecordingLogger());
        await seedHistory(db);
    });

    after(() => db.close());

    upstreamCases(() => db);

    const link = {
        id: CHANNEL_LINK,
        discordChannelId: 'dc-1',
        fluxerChannelId: 'fc-1',
    };

    it('finds the newest history copy of each side', async () => {
        const store = new SqlCatchUpStore(db, () => true);
        assert.equal(
            await store.newestHistoryCopy(link, 'discord'),
            HISTORY_DISCORD
        );
        assert.equal(
            await store.newestHistoryCopy(link, 'fluxer'),
            HISTORY_FLUXER
        );
        const other = { ...link, discordChannelId: 'x', fluxerChannelId: 'y' };
        assert.equal(await store.newestHistoryCopy(other, 'discord'), null);
    });

    it('tells history originals and copies by either ID', async () => {
        const store = new SqlCatchUpStore(db, () => true);
        assert.equal(
            await store.isHistoryCopy('discord', HISTORY_DISCORD),
            true
        );
        assert.equal(await store.isHistoryCopy('fluxer', HISTORY_FLUXER), true);
        assert.equal(
            await store.isHistoryCopy('fluxer', HISTORY_DISCORD),
            false
        );
    });
});
