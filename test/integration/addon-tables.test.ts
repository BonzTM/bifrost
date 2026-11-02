import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { DataTypes, Sequelize } from 'sequelize';
import {
    createAddonUmzug,
    runAddonMigrations,
} from '../../src/addons/db/migrator';
import { TABLES } from '../../src/addons/db/schema';
import { createRecordingLogger } from '../addons/fakes';

/**
 * Runs the add-on migrations against a real Postgres. Set
 * BF_TEST_POSTGRES_URL to a throwaway database; the test drops and recreates
 * its public schema. Skipped when the variable is unset.
 */
const url = process.env.BF_TEST_POSTGRES_URL;

describe('add-on tables on Postgres', { skip: !url }, () => {
    let db: Sequelize;
    let guildLinkId: string;

    before(async () => {
        db = new Sequelize(url ?? '', { logging: false });
        await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
        // The upstream table the add-on tables reference.
        await db.getQueryInterface().createTable('guild_links', {
            id: { type: DataTypes.UUID, primaryKey: true },
            discordGuildId: { type: DataTypes.STRING },
            fluxerGuildId: { type: DataTypes.STRING },
            createdAt: { type: DataTypes.DATE, allowNull: false },
        });
        guildLinkId = randomUUID();
        await db.query(
            `INSERT INTO guild_links (id, "discordGuildId", "fluxerGuildId", "createdAt") VALUES ($1, 'd', 'f', now())`,
            { bind: [guildLinkId] }
        );
    });

    after(() => db.close());

    it('applies the baseline once', async () => {
        const logger = createRecordingLogger();
        assert.deepEqual(await runAddonMigrations(db, logger), [
            '00001-addon-baseline',
        ]);
        assert.deepEqual(await runAddonMigrations(db, logger), []);
        const tables = await db.getQueryInterface().showAllTables();
        for (const table of Object.values(TABLES)) {
            assert.ok(tables.includes(table), `${table} exists`);
        }
    });

    it('fills settings defaults from the design', async () => {
        await db.query(
            `INSERT INTO ${TABLES.settings} ("guildLinkId", "updatedAt") VALUES ($1, now())`,
            { bind: [guildLinkId] }
        );
        const [rows] = await db.query(
            `SELECT mode, direction, "killSwitch", "deleteBudgetPerCycle", "deleteBudgetPerDay", "gracePeriodDays", "writeCapPerCycle" FROM ${TABLES.settings}`
        );
        assert.deepEqual(rows, [
            {
                mode: 'dry-run',
                direction: 'discord-to-fluxer',
                killSwitch: false,
                deleteBudgetPerCycle: 3,
                deleteBudgetPerDay: 10,
                gracePeriodDays: 14,
                writeCapPerCycle: 50,
            },
        ]);
    });

    it('rejects values outside the allowed lists', async () => {
        await assert.rejects(
            db.query(
                `UPDATE ${TABLES.settings} SET mode = 'yolo' WHERE "guildLinkId" = $1`,
                { bind: [guildLinkId] }
            )
        );
        await assert.rejects(
            db.query(
                `UPDATE ${TABLES.settings} SET "writeCapPerCycle" = 0 WHERE "guildLinkId" = $1`,
                { bind: [guildLinkId] }
            )
        );
        await assert.rejects(insertMapping('webhook', 'd1', 'f1'));
        await assert.rejects(insertMapping('role', null, null));
    });

    it('keeps one mapping per source and per destination object', async () => {
        await insertMapping('role', 'd2', 'f2');
        await assert.rejects(insertMapping('role', 'd2', 'f3'));
        await assert.rejects(insertMapping('role', 'd3', 'f2'));
        await insertMapping('channel', 'd2', 'f2');
    });

    it('drops mappings and settings when the guild link is removed', async () => {
        await db.query('DELETE FROM guild_links WHERE id = $1', {
            bind: [guildLinkId],
        });
        const [[map], [settings]] = await Promise.all([
            db.query(`SELECT count(*)::int AS n FROM ${TABLES.objectMap}`),
            db.query(`SELECT count(*)::int AS n FROM ${TABLES.settings}`),
        ]);
        assert.deepEqual([map, settings], [[{ n: 0 }], [{ n: 0 }]]);
    });

    it('reverts cleanly', async () => {
        await createAddonUmzug(db).down({ to: 0 });
        const tables = await db.getQueryInterface().showAllTables();
        for (const table of Object.values(TABLES)) {
            assert.ok(!tables.includes(table), `${table} dropped`);
        }
    });

    function insertMapping(
        kind: string,
        discordId: string | null,
        fluxerId: string | null
    ) {
        return db.query(
            `INSERT INTO ${TABLES.objectMap} (id, "guildLinkId", kind, "discordId", "fluxerId", "createdBySync", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, true, now(), now())`,
            { bind: [randomUUID(), guildLinkId, kind, discordId, fluxerId] }
        );
    }
});
