import { after, before, describe } from 'node:test';
import { Sequelize } from 'sequelize';
import { prepareUpstream, upstreamCases } from './catch-up-store-cases';

/**
 * Upstream's default database is SQLite (src/db/sequelize.ts), so the
 * catch-up queries over its tables must run there too: an in-memory one.
 */
describe('SqlCatchUpStore on SQLite', () => {
    let db: Sequelize;

    before(async () => {
        db = new Sequelize({
            dialect: 'sqlite',
            storage: ':memory:',
            logging: false,
        });
        await prepareUpstream(db);
    });

    after(() => db.close());

    upstreamCases(() => db);
});
