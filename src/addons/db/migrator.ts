import type { QueryInterface, Sequelize } from 'sequelize';
import { SequelizeStorage, Umzug, type RunnableMigration } from 'umzug';
import type { AddonConfig } from '../config';
import type { AddonLogger } from '../isolation';
import * as baseline from './migrations/00001-addon-baseline';
import { MIGRATIONS_TABLE } from './schema';

/**
 * Add-on migrations, listed explicitly in order. Upstream's migrations stay
 * in `src/db/migrations` and its own Umzug storage; these run after them
 * with a separate storage table, so the two never interleave.
 */
const MIGRATIONS: RunnableMigration<QueryInterface>[] = [
    { name: '00001-addon-baseline', up: baseline.up, down: baseline.down },
];

export class AddonDatabaseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AddonDatabaseError';
    }
}

export function createAddonUmzug(sequelize: Sequelize) {
    return new Umzug({
        migrations: MIGRATIONS,
        context: sequelize.getQueryInterface(),
        storage: new SequelizeStorage({
            sequelize,
            tableName: MIGRATIONS_TABLE,
        }),
        logger: undefined,
    });
}

/** Applies pending add-on migrations. Returns the names it applied. */
export async function runAddonMigrations(
    sequelize: Sequelize,
    logger: AddonLogger
): Promise<string[]> {
    const dialect = sequelize.getDialect();
    if (dialect !== 'postgres') {
        throw new AddonDatabaseError(
            `Add-on tables need Postgres, but the database is ${dialect}`
        );
    }
    const applied = await createAddonUmzug(sequelize).up();
    const names = applied.map((migration) => migration.name);
    if (names.length > 0) {
        logger.info(`[addons] Applied migrations: ${names.join(', ')}`);
    }
    return names;
}

/**
 * Prepares the add-on tables at startup. Does nothing when add-ons are off,
 * so a plain Bifröst install never gets them.
 */
export async function initAddonDatabase(
    config: AddonConfig,
    sequelize: Sequelize,
    logger: AddonLogger
): Promise<void> {
    if (!config.enabled) return;
    await runAddonMigrations(sequelize, logger);
}
