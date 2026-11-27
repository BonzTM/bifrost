import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import type { Sequelize } from 'sequelize';
import { up as baseline } from '../../src/db/migrations/00001-baseline';
import { SqlCatchUpStore } from '../../src/relay-extras/catchUp/store';
import { HOUR, idAt, NOW } from './catch-up-fakes';

/**
 * SqlCatchUpStore cases over upstream's tables, shared by the SQLite unit
 * test and the Postgres integration test.
 */

export const GUILD_LINK = '00000000-0000-4000-8000-000000000001';
export const CHANNEL_LINK = '00000000-0000-4000-8000-000000000002';
const OTHER_LINK = '00000000-0000-4000-8000-000000000003';

/** The process start the cases split links at. */
export const BOOT = new Date(NOW - HOUR);

export const OLD_DISCORD = idAt(NOW - 5 * HOUR);
export const NEWEST_DISCORD = idAt(NOW - 2 * HOUR);
export const NEWEST_FLUXER = idAt(NOW - 2 * HOUR, 7);
/** Bridged after the process started: live work, not a gap bound. */
const LIVE_DISCORD = idAt(NOW - HOUR / 2);

async function insertChannelLink(db: Sequelize, id: string, n: number) {
    await db.query(
        `INSERT INTO channel_links (id, "guildLinkId", "discordChannelId", "fluxerChannelId", "discordWebhookId", "discordWebhookToken", "fluxerWebhookId", "fluxerWebhookToken", "linkId", "createdAt")
         VALUES (:id, :guild, :dc, :fc, 'dw', 'dt', 'fw', 'ft', :linkId, :at)`,
        {
            replacements: {
                id,
                guild: GUILD_LINK,
                dc: `dc-${n}`,
                fc: `fc-${n}`,
                linkId: `l${n}`,
                at: new Date(NOW - 100 * HOUR),
            },
        }
    );
}

async function insertMessageLink(
    db: Sequelize,
    channelLinkId: string,
    ids: { discord: string; fluxer: string },
    at: Date
) {
    await db.query(
        `INSERT INTO message_links (id, "guildLinkId", "channelLinkId", "discordMessageId", "fluxerMessageId", "createdAt")
         VALUES (:id, :guild, :channel, :discord, :fluxer, :at)`,
        {
            replacements: {
                id: randomUUID(),
                guild: GUILD_LINK,
                channel: channelLinkId,
                ...ids,
                at,
            },
        }
    );
}

/** Upstream's tables (baseline migration) and a few links. */
export async function prepareUpstream(db: Sequelize): Promise<void> {
    await baseline({
        name: '00001-baseline',
        context: db.getQueryInterface(),
    } as Parameters<typeof baseline>[0]);
    await db.query(
        `INSERT INTO guild_links (id, "discordGuildId", "fluxerGuildId", "createdAt")
         VALUES (:id, 'dg', 'fg', :at)`,
        { replacements: { id: GUILD_LINK, at: new Date(NOW - 100 * HOUR) } }
    );
    await insertChannelLink(db, CHANNEL_LINK, 1);
    await insertChannelLink(db, OTHER_LINK, 2);
    const before = new Date(BOOT.getTime() - 60_000);
    // A short ID sorts after a long one as text: '9' > '1...'.
    await insertMessageLink(
        db,
        CHANNEL_LINK,
        { discord: '9', fluxer: '8' },
        before
    );
    await insertMessageLink(
        db,
        CHANNEL_LINK,
        { discord: OLD_DISCORD, fluxer: idAt(NOW - 5 * HOUR, 1) },
        before
    );
    await insertMessageLink(
        db,
        CHANNEL_LINK,
        { discord: NEWEST_DISCORD, fluxer: NEWEST_FLUXER },
        before
    );
    await insertMessageLink(
        db,
        CHANNEL_LINK,
        { discord: LIVE_DISCORD, fluxer: idAt(NOW - HOUR / 2, 1) },
        new Date(BOOT.getTime() + 60_000)
    );
    await insertMessageLink(
        db,
        OTHER_LINK,
        { discord: idAt(NOW - 10_000), fluxer: idAt(NOW - 10_000, 1) },
        before
    );
    await db.query(
        `INSERT INTO queued_messages (id, direction, "channelLinkId", "sourceMessageId", payload, "retryCount", "createdAt")
         VALUES (:id, 'discord_to_fluxer', :channel, 'd-queued', '{}', 0, :at)`,
        {
            replacements: {
                id: randomUUID(),
                channel: CHANNEL_LINK,
                at: new Date(NOW),
            },
        }
    );
}

/** The cases that need only upstream's tables. */
export function upstreamCases(db: () => Sequelize): void {
    const store = () => new SqlCatchUpStore(db(), () => false);

    it('finds the newest message bridged before the process started', async () => {
        assert.equal(
            await store().newestBridged(CHANNEL_LINK, 'discord', BOOT),
            NEWEST_DISCORD
        );
        assert.equal(
            await store().newestBridged(CHANNEL_LINK, 'fluxer', BOOT),
            NEWEST_FLUXER
        );
    });

    it('returns null for a link with nothing bridged before', async () => {
        const early = new Date(NOW - 50 * HOUR);
        assert.equal(
            await store().newestBridged(CHANNEL_LINK, 'discord', early),
            null
        );
    });

    it('finds queued copies by direction', async () => {
        assert.equal(await store().isQueued('discord', 'd-queued'), true);
        assert.equal(await store().isQueued('fluxer', 'd-queued'), false);
        assert.equal(await store().isQueued('discord', 'other'), false);
    });

    it('reads no history table before the add-on migrations ran', async () => {
        const link = {
            id: CHANNEL_LINK,
            discordChannelId: 'dc-1',
            fluxerChannelId: 'fc-1',
        };
        assert.equal(await store().newestHistoryCopy(link, 'discord'), null);
        assert.equal(await store().isHistoryCopy('discord', 'x'), false);
    });
}
