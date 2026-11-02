import { DataTypes, type QueryInterface, type Transaction } from 'sequelize';
import {
    OBJECT_KINDS,
    OBJECT_STATES,
    PLAN_STATUSES,
    SNAPSHOT_SIDES,
    SYNC_DIRECTIONS,
    SYNC_MODES,
    TABLES,
} from '../schema';

/**
 * The add-on tables from the design's data model. Column names follow
 * upstream's camelCase style.
 *
 * Rows tied to a guild link cascade when upstream unlinks the guild. That
 * fails safe: without its `addon_object_map` rows, the bot owns nothing
 * there and will not touch it. The audit log has no foreign keys, so it
 * outlives the plans and links it describes.
 */

const guildLinkRef = {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'guild_links', key: 'id' },
    onDelete: 'CASCADE',
} as const;

async function addCheck(
    qi: QueryInterface,
    transaction: Transaction,
    table: string,
    field: string,
    values: readonly (string | number)[]
): Promise<void> {
    await qi.addConstraint(table, {
        type: 'check',
        name: `${table}_${field}_check`,
        fields: [field],
        where: { [field]: [...values] },
        transaction,
    });
}

async function createObjectMap(
    qi: QueryInterface,
    transaction: Transaction
): Promise<void> {
    const table = TABLES.objectMap;
    await qi.createTable(
        table,
        {
            id: { type: DataTypes.UUID, primaryKey: true },
            guildLinkId: guildLinkRef,
            kind: { type: DataTypes.STRING, allowNull: false },
            discordId: { type: DataTypes.STRING, allowNull: true },
            fluxerId: { type: DataTypes.STRING, allowNull: true },
            state: {
                type: DataTypes.STRING,
                allowNull: false,
                defaultValue: 'active',
            },
            createdBySync: { type: DataTypes.BOOLEAN, allowNull: false },
            lastSeenSourceAt: { type: DataTypes.DATE, allowNull: true },
            missingSince: { type: DataTypes.DATE, allowNull: true },
            missingCount: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 0,
            },
            createdAt: { type: DataTypes.DATE, allowNull: false },
            updatedAt: { type: DataTypes.DATE, allowNull: false },
        },
        { transaction }
    );
    await addCheck(qi, transaction, table, 'kind', OBJECT_KINDS);
    await addCheck(qi, transaction, table, 'state', OBJECT_STATES);
    await qi.sequelize.query(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_ids_check" CHECK ("discordId" IS NOT NULL OR "fluxerId" IS NOT NULL), ADD CONSTRAINT "${table}_missing_count_check" CHECK ("missingCount" >= 0)`,
        { transaction }
    );
    await qi.addIndex(table, ['guildLinkId', 'kind', 'discordId'], {
        transaction,
        unique: true,
        name: `${table}_discord_unique`,
    });
    await qi.addIndex(table, ['guildLinkId', 'kind', 'fluxerId'], {
        transaction,
        unique: true,
        name: `${table}_fluxer_unique`,
    });
}

async function createSnapshots(
    qi: QueryInterface,
    transaction: Transaction
): Promise<void> {
    const table = TABLES.snapshots;
    await qi.createTable(
        table,
        {
            id: { type: DataTypes.UUID, primaryKey: true },
            guildLinkId: guildLinkRef,
            side: { type: DataTypes.STRING, allowNull: false },
            takenAt: { type: DataTypes.DATE, allowNull: false },
            healthy: { type: DataTypes.BOOLEAN, allowNull: false },
            objectCounts: { type: DataTypes.JSONB, allowNull: false },
            payload: { type: DataTypes.JSONB, allowNull: false },
        },
        { transaction }
    );
    await addCheck(qi, transaction, table, 'side', SNAPSHOT_SIDES);
    await qi.addIndex(table, ['guildLinkId', 'side', 'takenAt'], {
        transaction,
        name: `${table}_link_side_taken_at`,
    });
}

async function createPlans(
    qi: QueryInterface,
    transaction: Transaction
): Promise<void> {
    const table = TABLES.plans;
    await qi.createTable(
        table,
        {
            id: { type: DataTypes.UUID, primaryKey: true },
            guildLinkId: guildLinkRef,
            direction: { type: DataTypes.STRING, allowNull: false },
            status: { type: DataTypes.STRING, allowNull: false },
            ops: { type: DataTypes.JSONB, allowNull: false },
            abortReason: { type: DataTypes.TEXT, allowNull: true },
            createdAt: { type: DataTypes.DATE, allowNull: false },
            updatedAt: { type: DataTypes.DATE, allowNull: false },
        },
        { transaction }
    );
    await addCheck(qi, transaction, table, 'direction', SYNC_DIRECTIONS);
    await addCheck(qi, transaction, table, 'status', PLAN_STATUSES);
    await qi.addIndex(table, ['guildLinkId', 'createdAt'], {
        transaction,
        name: `${table}_link_created_at`,
    });
    await qi.addIndex(table, ['status'], {
        transaction,
        name: `${table}_status`,
    });
}

async function createAuditLog(
    qi: QueryInterface,
    transaction: Transaction
): Promise<void> {
    const table = TABLES.auditLog;
    await qi.createTable(
        table,
        {
            id: {
                type: DataTypes.BIGINT,
                primaryKey: true,
                autoIncrement: true,
            },
            planId: { type: DataTypes.UUID, allowNull: true },
            guildLinkId: { type: DataTypes.UUID, allowNull: false },
            op: { type: DataTypes.STRING, allowNull: false },
            kind: { type: DataTypes.STRING, allowNull: false },
            sourceId: { type: DataTypes.STRING, allowNull: true },
            destId: { type: DataTypes.STRING, allowNull: true },
            before: { type: DataTypes.JSONB, allowNull: true },
            after: { type: DataTypes.JSONB, allowNull: true },
            result: { type: DataTypes.STRING, allowNull: false },
            at: { type: DataTypes.DATE, allowNull: false },
        },
        { transaction }
    );
    await addCheck(qi, transaction, table, 'kind', OBJECT_KINDS);
    await qi.addIndex(table, ['planId'], {
        transaction,
        name: `${table}_plan_id`,
    });
    await qi.addIndex(table, ['guildLinkId', 'at'], {
        transaction,
        name: `${table}_link_at`,
    });
}

const intColumn = (defaultValue: number) => ({
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue,
});

async function createSettings(
    qi: QueryInterface,
    transaction: Transaction
): Promise<void> {
    const table = TABLES.settings;
    await qi.createTable(
        table,
        {
            guildLinkId: { ...guildLinkRef, primaryKey: true },
            direction: {
                type: DataTypes.STRING,
                allowNull: false,
                defaultValue: 'discord-to-fluxer',
            },
            mode: {
                type: DataTypes.STRING,
                allowNull: false,
                defaultValue: 'dry-run',
            },
            killSwitch: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: false,
            },
            shrinkPercent: intColumn(10),
            shrinkMinObjects: intColumn(5),
            confirmChecks: intColumn(3),
            confirmMinutes: intColumn(30),
            gracePeriodDays: intColumn(14),
            deleteBudgetPerCycle: intColumn(3),
            deleteBudgetPerDay: intColumn(10),
            writeCapPerCycle: intColumn(50),
            updatedAt: { type: DataTypes.DATE, allowNull: false },
            updatedBy: { type: DataTypes.STRING, allowNull: true },
        },
        { transaction }
    );
    await addCheck(qi, transaction, table, 'direction', SYNC_DIRECTIONS);
    await addCheck(qi, transaction, table, 'mode', SYNC_MODES);
    await qi.sequelize.query(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_limits_check" CHECK ("shrinkPercent" BETWEEN 1 AND 100 AND "shrinkMinObjects" >= 0 AND "confirmChecks" >= 1 AND "confirmMinutes" >= 0 AND "gracePeriodDays" >= 0 AND "deleteBudgetPerCycle" >= 0 AND "deleteBudgetPerDay" >= 0 AND "writeCapPerCycle" >= 1)`,
        { transaction }
    );
}

async function createLeaderLock(
    qi: QueryInterface,
    transaction: Transaction
): Promise<void> {
    const table = TABLES.leaderLock;
    await qi.createTable(
        table,
        {
            id: { type: DataTypes.INTEGER, primaryKey: true },
            holder: { type: DataTypes.STRING, allowNull: false },
            acquiredAt: { type: DataTypes.DATE, allowNull: false },
            heartbeatAt: { type: DataTypes.DATE, allowNull: false },
        },
        { transaction }
    );
    await addCheck(qi, transaction, table, 'id', [1]);
}

export async function up({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    // Postgres DDL is transactional: a failure anywhere rolls every table
    // back, so the next startup retries from a clean schema.
    await qi.sequelize.transaction(async (transaction) => {
        await createObjectMap(qi, transaction);
        await createSnapshots(qi, transaction);
        await createPlans(qi, transaction);
        await createAuditLog(qi, transaction);
        await createSettings(qi, transaction);
        await createLeaderLock(qi, transaction);
    });
}

export async function down({
    context: qi,
}: {
    context: QueryInterface;
}): Promise<void> {
    const order = [
        TABLES.leaderLock,
        TABLES.settings,
        TABLES.auditLog,
        TABLES.plans,
        TABLES.snapshots,
        TABLES.objectMap,
    ];
    await qi.sequelize.transaction(async (transaction) => {
        for (const table of order) await qi.dropTable(table, { transaction });
    });
}
