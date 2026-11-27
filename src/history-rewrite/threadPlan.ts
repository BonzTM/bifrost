import { contentHash } from '../history/format';
import {
    bigintPart,
    bigintValue,
    bucketOf,
    messagePartitionKey,
    reactionRowKey,
    snowflakeTime,
} from '../fluxer-db/keys';
import { nativeContent, withoutReplyQuote } from './content';
import { idOf, primaryKey, rekey, type StoredRow } from './kvRows';
import {
    originalFrom,
    type KvRow,
    type Original,
    type ReplyTarget,
} from './plan';
import type { DoneCopy } from './sources';

/**
 * Plans moving one Fluxer thread to its Discord thread's ID, with every
 * row that names it (docs/design/history-rewrite.md, "Threads"). Fluxer
 * refuses a thread message whose ID is not above the thread's, so the
 * thread must take its Discord ID before its copies can take theirs. A
 * forum post's first message shares the thread's ID on both platforms.
 */

/** A history copy in the thread, from bifrost's table and the archive. */
export interface ThreadCopy {
    readonly discordMessageId: string;
    readonly raw: unknown;
}

export interface ThreadInput {
    readonly oldId: string;
    readonly newId: string;
    readonly botUserId: string;
    /** Webhook IDs: a thread a webhook owns is given to the bot. */
    readonly webhookIds: ReadonlySet<string>;
    /** Copies by their current Fluxer message ID. */
    readonly copies: ReadonlyMap<string, ThreadCopy>;
    /** The Discord starter's archived JSON, for a forum post. */
    readonly starterRaw: unknown;
    readonly emojis: ReadonlyMap<string, string>;
    readonly replyTarget: (discordMessageId: string) => ReplyTarget | null;
    /** Every row that names the thread (ThreadSource.rows). */
    readonly rows: readonly StoredRow[];
    readonly now: Date;
}

export interface FileMove {
    readonly from: string;
    readonly to: string;
}

export interface ThreadPlan {
    readonly deletes: readonly { table: string; key: string }[];
    readonly inserts: readonly KvRow[];
    readonly done: readonly DoneCopy[];
    readonly files: readonly FileMove[];
    readonly stats: ThreadStats;
}

export interface ThreadStats {
    messages: number;
    copies: number;
    nativeReplies: number;
    reactions: number;
    edited: number;
    undated: number;
}

const THREAD_TABLES = new Set([
    'thread_state',
    'thread_stats',
    'threads_by_parent',
    'active_threads_by_guild',
    'archived_threads_by_parent',
    'thread_members',
    'thread_members_by_user',
]);
const MOVED_BY_CHANNEL = new Set([
    'message_reactions',
    'channel_pins',
    'attachment_lookup',
    'attachment_decay_by_id',
    'attachment_decay_by_expiry',
    'messages_by_author_id_v2',
    'read_states',
]);

type Data = Record<string, unknown>;

/** Plans the whole move. Pure: the caller reads the rows and writes the plan. */
export function planThread(input: ThreadInput): ThreadPlan {
    const ids = messageIdMap(input);
    const ctx = new Planner(input, ids);
    for (const row of input.rows) ctx.row(row);
    ctx.finish();
    return ctx.result();
}

/** Old message ID → new, for every message in the thread. */
function messageIdMap(input: ThreadInput): Map<string, string> {
    const map = new Map<string, string>();
    for (const row of input.rows) {
        if (row.table_name !== 'messages') continue;
        if (idOf(row.row_data.channel_id) !== input.oldId) continue;
        const id = idOf(row.row_data.message_id);
        if (!id) continue;
        const copy = input.copies.get(id);
        map.set(
            id,
            id === input.oldId ? input.newId : (copy?.discordMessageId ?? id)
        );
    }
    for (const [from, to] of map) {
        if (to !== input.newId && BigInt(to) <= BigInt(input.newId)) {
            throw new Error(
                `Message ${from} would not be newer than thread ${input.newId}`
            );
        }
    }
    return map;
}

class Planner {
    private readonly deletes: { table: string; key: string }[] = [];
    private readonly inserts = new Map<string, KvRow>();
    private readonly done: DoneCopy[] = [];
    private readonly files = new Map<string, FileMove>();
    private readonly buckets = new Set<number>();
    private newest: string | null = null;
    private readonly stats: ThreadStats = {
        messages: 0,
        copies: 0,
        nativeReplies: 0,
        reactions: 0,
        edited: 0,
        undated: 0,
    };

    constructor(
        private readonly input: ThreadInput,
        private readonly ids: ReadonlyMap<string, string>
    ) {}

    row(row: StoredRow): void {
        const table = row.table_name;
        const inThread = idOf(row.row_data.channel_id) === this.input.oldId;
        if (table === 'messages' && inThread) this.message(row);
        else if (table === 'messages') this.parentMessage(row);
        else if (MOVED_BY_CHANNEL.has(table))
            this.move(row, this.movedData(row.row_data));
        else if (THREAD_TABLES.has(table))
            this.move(row, this.threadData(row.row_data));
        else if (table === 'channels' && inThread) this.channel(row);
        else if (table === 'channels') this.parentChannel(row);
        else if (
            table === 'channel_message_buckets' ||
            table === 'channel_empty_buckets'
        )
            this.deletes.push({ table, key: row.row_key });
        else if (table === 'channel_state') this.channelState(row);
        else if (table === 'user_guild_settings') this.settings(row);
        else throw new Error(`Unexpected row in ${table}`);
    }

    finish(): void {
        this.flushLast();
        const partition = bigintPart(this.input.newId);
        for (const bucket of this.buckets) {
            this.add({
                tableName: 'channel_message_buckets',
                partitionKey: partition,
                rowKey: `${partition}\u001f${bucket}`,
                rowData: {
                    bucket,
                    channel_id: bigintValue(this.input.newId),
                    updated_at: {
                        __fluxer_type: 'date',
                        value: this.input.now.toISOString(),
                    },
                },
                sortId: null,
            });
        }
    }

    result(): ThreadPlan {
        return {
            deletes: this.deletes,
            inserts: [...this.inserts.values()],
            done: this.done,
            files: [...this.files.values()],
            stats: this.stats,
        };
    }

    private add(row: KvRow): void {
        this.inserts.set(`${row.tableName}\u0000${row.rowKey}`, row);
    }

    private move(
        row: StoredRow,
        data: Data,
        sortId: string | null = row.sort_id
    ): void {
        this.deletes.push({ table: row.table_name, key: row.row_key });
        this.add(rekey(row, data, primaryKey(row.table_name), sortId));
    }

    private mapId(value: unknown): unknown {
        const id = idOf(value);
        const to = id ? this.ids.get(id) : undefined;
        return to ? bigintValue(to) : value;
    }

    /** A per-message row: new channel, and the message's new ID and bucket. */
    private movedData(data: Data): Data {
        const out: Data = {
            ...data,
            channel_id: bigintValue(this.input.newId),
        };
        if ('message_id' in data) out.message_id = this.mapId(data.message_id);
        if ('bucket' in data) {
            const id = idOf(out.message_id);
            if (id) out.bucket = bucketOf(id);
        }
        return out;
    }

    private threadData(data: Data): Data {
        const out: Data = { ...data, thread_id: bigintValue(this.input.newId) };
        if ('channel_id' in data)
            out.channel_id = bigintValue(this.input.newId);
        return out;
    }

    private message(row: StoredRow): void {
        const oldMessageId = idOf(row.row_data.message_id) ?? '';
        const newMessageId = this.ids.get(oldMessageId) ?? oldMessageId;
        const copy = this.input.copies.get(oldMessageId);
        const starter = oldMessageId === this.input.oldId;
        let data = this.relocated(row.row_data, newMessageId);
        if (copy || starter) {
            data = this.native(data, newMessageId, copy ?? null);
            if (copy) this.recordDone(oldMessageId, copy, data);
        } else {
            data = this.referencesMoved(data);
        }
        this.stats.messages++;
        this.buckets.add(bucketOf(newMessageId));
        if (!this.newest || BigInt(newMessageId) > BigInt(this.newest))
            this.newest = newMessageId;
        this.move(row, data, newMessageId);
        this.collectFiles(row.row_data);
    }

    private relocated(data: Data, messageId: string): Data {
        const out: Data = {
            ...data,
            channel_id: bigintValue(this.input.newId),
            message_id: bigintValue(messageId),
            bucket: bucketOf(messageId),
        };
        if (Array.isArray(data.embeds)) {
            const text = JSON.stringify(data.embeds)
                .split(`/attachments/${this.input.oldId}/`)
                .join(`/attachments/${this.input.newId}/`);
            out.embeds = JSON.parse(text) as unknown;
        }
        return out;
    }

    /** A copy or starter: no date or reactions line, Fluxer reply, reactions. */
    private native(
        data: Data,
        messageId: string,
        copy: ThreadCopy | null
    ): Data {
        const original = originalFrom(copy ? copy.raw : this.input.starterRaw);
        const content = typeof data.content === 'string' ? data.content : '';
        const stripped = nativeContent(content, snowflakeTime(messageId));
        if (stripped === null) this.stats.undated++;
        const out: Data = { ...data, content: stripped ?? content };
        const reference = this.replyReference(original);
        if (reference) {
            out.message_reference = reference;
            if (Array.isArray(out.embeds))
                out.embeds = withoutReplyQuote(out.embeds);
            this.stats.nativeReplies++;
        }
        if (original.editedAt) {
            out.edited_timestamp = {
                __fluxer_type: 'date',
                value: original.editedAt,
            };
            this.stats.edited++;
        }
        const added = this.reactions(original, messageId);
        if (added > 0) out.has_reaction = true;
        return out;
    }

    private replyReference(original: Original): Data | null {
        if (!original.replyTo) return null;
        // A forum post's first message is guild-sync's post, not a history
        // copy; on both platforms it shares the thread's ID.
        const starter =
            original.replyTo === this.input.newId &&
            this.ids.has(this.input.oldId)
                ? {
                      fluxerChannelId: this.input.newId,
                      fluxerMessageId: this.input.newId,
                  }
                : null;
        const target = starter ?? this.input.replyTarget(original.replyTo);
        if (!target || target.fluxerChannelId !== this.input.newId) return null;
        return {
            type: 0,
            guild_id: null,
            channel_id: bigintValue(this.input.newId),
            message_id: bigintValue(target.fluxerMessageId),
        };
    }

    private reactions(original: Original, messageId: string): number {
        const seen = new Set<string>();
        for (const reaction of original.reactions) {
            const emojiId =
                reaction.id === null ? '0' : this.input.emojis.get(reaction.id);
            if (
                emojiId === undefined ||
                seen.has(`${emojiId}:${reaction.name}`)
            )
                continue;
            seen.add(`${emojiId}:${reaction.name}`);
            const fields = {
                channelId: this.input.newId,
                messageId,
                emojiId,
                emojiName: reaction.name,
                userId: this.input.botUserId,
            };
            const rowKey = reactionRowKey(fields);
            if (this.inserts.has(`message_reactions\u0000${rowKey}`)) continue;
            this.add({
                tableName: 'message_reactions',
                partitionKey: messagePartitionKey(this.input.newId, messageId),
                rowKey,
                rowData: {
                    channel_id: bigintValue(this.input.newId),
                    bucket: bucketOf(messageId),
                    message_id: bigintValue(messageId),
                    user_id: bigintValue(this.input.botUserId),
                    emoji_id: bigintValue(emojiId),
                    emoji_name: reaction.name,
                    emoji_animated: reaction.animated,
                    created_at: {
                        __fluxer_type: 'date',
                        value: snowflakeTime(messageId).toISOString(),
                    },
                },
                sortId: messageId,
            });
            this.stats.reactions++;
        }
        return seen.size;
    }

    private referencesMoved(data: Data): Data {
        const ref = data.message_reference as Data | null | undefined;
        if (!ref || idOf(ref.channel_id) !== this.input.oldId) return data;
        return {
            ...data,
            message_reference: {
                ...ref,
                channel_id: bigintValue(this.input.newId),
                message_id: this.mapId(ref.message_id),
            },
        };
    }

    private recordDone(
        oldMessageId: string,
        copy: ThreadCopy,
        data: Data
    ): void {
        this.stats.copies++;
        this.done.push({
            discordMessageId: copy.discordMessageId,
            oldFluxerMessageId: oldMessageId,
            nativeReply:
                typeof data.message_reference === 'object' &&
                data.message_reference !== null,
            contentHash: contentHash(
                typeof data.content === 'string' ? data.content : ''
            ),
        });
    }

    private collectFiles(data: Data): void {
        const old = this.input.oldId;
        const add = (rest: string) =>
            this.files.set(rest, {
                from: `attachments/${old}/${rest}`,
                to: `attachments/${this.input.newId}/${rest}`,
            });
        const files = Array.isArray(data.attachments) ? data.attachments : [];
        for (const file of files as Data[]) {
            const id = idOf(file.attachment_id);
            if (id && typeof file.filename === 'string')
                add(`${id}/${file.filename}`);
        }
        const text = JSON.stringify(data.embeds ?? []);
        for (const match of text.matchAll(
            new RegExp(`/attachments/${old}/([^"?#\\s]+)`, 'g')
        )) {
            if (match[1]) add(match[1]);
        }
    }

    /** A parent message that points at the thread (THREAD_CREATED). */
    private parentMessage(row: StoredRow): void {
        this.move(row, this.referencesMoved(row.row_data));
    }

    private channel(row: StoredRow): void {
        const owner = idOf(row.row_data.owner_id);
        const data: Data = {
            ...row.row_data,
            channel_id: bigintValue(this.input.newId),
            indexed_at: null,
            ...(owner && this.input.webhookIds.has(owner)
                ? { owner_id: bigintValue(this.input.botUserId) }
                : {}),
        };
        this.pendingChannel = { row, data };
    }

    private pendingChannel: { row: StoredRow; data: Data } | null = null;
    private pendingState: StoredRow | null = null;

    /** A forum's last_message_id can hold a thread ID. */
    private parentChannel(row: StoredRow): void {
        this.move(row, {
            ...row.row_data,
            last_message_id: bigintValue(this.input.newId),
        });
    }

    private channelState(row: StoredRow): void {
        this.pendingState = row;
    }

    private settings(row: StoredRow): void {
        const text = JSON.stringify(row.row_data)
            .split(`"${this.input.oldId}"`)
            .join(`"${this.input.newId}"`);
        this.move(row, JSON.parse(text) as Data);
    }

    /** Channel and channel_state need the newest message, known at the end. */
    flushLast(): void {
        const newest = this.newest;
        if (this.pendingChannel) {
            const { row, data } = this.pendingChannel;
            this.move(
                row,
                newest
                    ? { ...data, last_message_id: bigintValue(newest) }
                    : data
            );
        }
        if (this.pendingState) {
            const row = this.pendingState;
            this.move(row, {
                ...row.row_data,
                channel_id: bigintValue(this.input.newId),
                created_bucket: bucketOf(this.input.newId),
                has_messages: newest !== null,
                ...(newest
                    ? {
                          last_message_id: bigintValue(newest),
                          last_message_bucket: bucketOf(newest),
                      }
                    : {}),
            });
        }
    }
}
