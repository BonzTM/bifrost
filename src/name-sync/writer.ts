import { bucketOf, messageRowKey } from '../fluxer-db/keys';
import type { FluxerDb } from '../fluxer-db/pool';
import type { CopyRef } from './store';
import { chunks } from './names';

/** Keys sent per call; bifrost.set_webhook_names refuses more. */
export const NAME_BATCH = 500;
/** Channels sent per call; bifrost.lower_created_buckets refuses more. */
export const BUCKET_BATCH = 1_000;

/**
 * Sets webhook_name on Fluxer copies through the bifrost.set_webhook_names
 * function (deploy/fluxer-bridge.sql). The role it connects with can run
 * that function and nothing else.
 */
export class FluxerNameWriter {
    constructor(private readonly db: Pick<FluxerDb, 'rows'>) {}

    /** Checks the function exists and the role may run it. */
    async check(): Promise<void> {
        await this.setBatch([], 'check');
    }

    /**
     * Gives every thread a webhook owns to `ownerId`, the bot
     * (bifrost.give_webhook_threads). Guild-sync's forum posts are made
     * through a webhook, so otherwise every copy shows the OP tag. Returns
     * how many threads changed.
     */
    async giveWebhookThreads(ownerId: string): Promise<number> {
        if (!/^\d{1,20}$/.test(ownerId)) throw new Error('Not a user ID');
        const rows = await this.db.rows<{ changed: unknown }>(
            'SELECT bifrost.give_webhook_threads($1) AS changed',
            [ownerId]
        );
        return countOf(rows);
    }

    /**
     * Keeps each channel's search lower bound at or below its oldest moved
     * copy (bifrost.lower_created_buckets). Fluxer resets the bound on every
     * new message, and its search rebuild never reads below it. Takes
     * channel ID → oldest message ID. Returns how many channels changed.
     */
    async lowerBuckets(oldest: ReadonlyMap<string, string>): Promise<number> {
        const entries = [...oldest].map(([channel, message]) => ({
            channel_id: channel,
            bucket: bucketOf(message),
        }));
        let changed = 0;
        for (const batch of chunks(entries, BUCKET_BATCH)) {
            const rows = await this.db.rows<{ changed: unknown }>(
                'SELECT bifrost.lower_created_buckets($1::jsonb) AS changed',
                [JSON.stringify(batch)]
            );
            changed += countOf(rows);
        }
        return changed;
    }

    /** Renames the copies. Returns how many rows changed. */
    async rename(copies: readonly CopyRef[], name: string): Promise<number> {
        const keys = copies.map((c) => messageRowKey(c.channelId, c.messageId));
        let changed = 0;
        for (const batch of chunks(keys, NAME_BATCH)) {
            changed += await this.setBatch(batch, name);
        }
        return changed;
    }

    private async setBatch(keys: readonly string[], name: string) {
        const rows = await this.db.rows<{ changed: unknown }>(
            'SELECT bifrost.set_webhook_names($1::text[], $2) AS changed',
            [keys, name]
        );
        return countOf(rows);
    }
}

/** The count a bridge function returns. */
function countOf(rows: readonly { changed: unknown }[]): number {
    const changed = rows[0]?.changed;
    if (typeof changed !== 'number' || changed < 0) {
        throw new Error('The bridge function returned no count');
    }
    return changed;
}
