import { QueryTypes, type Sequelize } from 'sequelize';
import { TABLES } from '../../addons/db/schema';
import type { Side } from '../types';

/**
 * The database reads catch-up needs. message_links and queued_messages
 * are upstream's tables (src/db/migrations/00001-baseline.ts) and exist on
 * SQLite and Postgres alike, so their SQL stays plain. The history tables
 * exist only while the add-on migrations ran ('ready'), on Postgres.
 *
 * Message IDs are stored as text. A newer snowflake is never shorter, so
 * ordering by length, then text, finds the newest.
 */

export interface LinkedChannels {
    readonly id: string;
    readonly discordChannelId: string;
    readonly fluxerChannelId: string;
}

export interface CatchUpStore {
    /** Newest message of `side` the link bridged before `before`. */
    newestBridged(
        channelLinkId: string,
        side: Side,
        before: Date
    ): Promise<string | null>;
    /** Newest history copy of `side` in the linked channel. */
    newestHistoryCopy(link: LinkedChannels, side: Side): Promise<string | null>;
    /** True while a copy of the message waits in the retry queue. */
    isQueued(side: Side, messageId: string): Promise<boolean>;
    /** True when the message is a history original or copy. */
    isHistoryCopy(side: Side, messageId: string): Promise<boolean>;
}

type Row = Record<string, unknown>;

const DIRECTION: Record<Side, string> = {
    discord: 'discord_to_fluxer',
    fluxer: 'fluxer_to_discord',
};

const COLUMN: Record<Side, string> = {
    discord: '"discordMessageId"',
    fluxer: '"fluxerMessageId"',
};

function newestOrder(column: string): string {
    return `ORDER BY LENGTH(${column}) DESC, ${column} DESC LIMIT 1`;
}

function firstId(rows: readonly Row[]): string | null {
    const id = rows[0]?.id;
    return typeof id === 'string' && id !== '' ? id : null;
}

export class SqlCatchUpStore implements CatchUpStore {
    constructor(
        private readonly db: Sequelize,
        /** True once the add-on tables exist (src/addons/state.ts). */
        private readonly historyReady: () => boolean
    ) {}

    async newestBridged(
        channelLinkId: string,
        side: Side,
        before: Date
    ): Promise<string | null> {
        const column = COLUMN[side];
        const rows = await this.db.query<Row>(
            `SELECT ${column} AS id FROM message_links
             WHERE "channelLinkId" = :channelLinkId AND "createdAt" < :before
             ${newestOrder(column)}`,
            { replacements: { channelLinkId, before }, type: QueryTypes.SELECT }
        );
        return firstId(rows);
    }

    async isQueued(side: Side, messageId: string): Promise<boolean> {
        const rows = await this.db.query<Row>(
            `SELECT 1 AS found FROM queued_messages
             WHERE direction = :direction AND "sourceMessageId" = :messageId
             LIMIT 1`,
            {
                replacements: { direction: DIRECTION[side], messageId },
                type: QueryTypes.SELECT,
            }
        );
        return rows.length > 0;
    }

    async newestHistoryCopy(
        link: LinkedChannels,
        side: Side
    ): Promise<string | null> {
        if (!this.historyReady()) return null;
        const rows =
            side === 'discord'
                ? await this.newestHistoryOriginal(link.discordChannelId)
                : await this.newestHistoryFluxerCopy(link.fluxerChannelId);
        return firstId(rows);
    }

    async isHistoryCopy(side: Side, messageId: string): Promise<boolean> {
        if (!this.historyReady()) return false;
        const rows = await this.db.query<Row>(
            `SELECT 1 AS found FROM ${TABLES.historyMessages}
             WHERE ${COLUMN[side]} = :messageId LIMIT 1`,
            { replacements: { messageId }, type: QueryTypes.SELECT }
        );
        return rows.length > 0;
    }

    private newestHistoryOriginal(discordChannelId: string): Promise<Row[]> {
        const column = 'm."discordMessageId"';
        return this.db.query<Row>(
            `SELECT ${column} AS id FROM ${TABLES.historyMessages} m
             JOIN ${TABLES.historyJobs} j ON j.id = m."jobId"
             WHERE j.kind = 'channel' AND j."discordId" = :discordChannelId
             ${newestOrder(column)}`,
            { replacements: { discordChannelId }, type: QueryTypes.SELECT }
        );
    }

    private newestHistoryFluxerCopy(fluxerChannelId: string): Promise<Row[]> {
        const column = 'm."fluxerMessageId"';
        return this.db.query<Row>(
            `SELECT ${column} AS id FROM ${TABLES.historyMessages} m
             WHERE m."fluxerTargetId" = :fluxerChannelId
               AND ${column} IS NOT NULL
             ${newestOrder(column)}`,
            { replacements: { fluxerChannelId }, type: QueryTypes.SELECT }
        );
    }
}
