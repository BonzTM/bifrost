import type { KvRow } from './plan';

/**
 * Generic re-keying of fluxer_kv rows. Each key part is
 * JSON.stringify(encodeValue(value)), joined with U+001F
 * (PostgresKvQueryExecutor.ts:105,281-287). row_data keeps typed values as
 * {"__fluxer_type": t, "value": v} (jsonb reorders those keys), so a key
 * part is rebuilt from the row's own value. The caller checks the rebuilt
 * old key against the stored one before trusting a column list.
 */

const SEPARATOR = '\u001f';

export interface StoredRow {
    readonly table_name: string;
    readonly partition_key: string;
    readonly row_key: string;
    readonly row_data: Record<string, unknown>;
    readonly sort_id: string | null;
}

export class KeyMismatchError extends Error {
    constructor(table: string, rowKey: string) {
        super(
            `Rebuilt key does not match the stored key in ${table}: ${rowKey}`
        );
        this.name = 'KeyMismatchError';
    }
}

/** One key part, exactly as Fluxer writes it. */
export function encodePart(value: unknown): string {
    if (
        typeof value === 'object' &&
        value !== null &&
        '__fluxer_type' in value
    ) {
        const typed = value as { __fluxer_type: unknown; value: unknown };
        return JSON.stringify({
            __fluxer_type: typed.__fluxer_type,
            value: typed.value,
        });
    }
    return JSON.stringify(value ?? null);
}

/** A row key from row_data and the table's primary key columns. */
export function keyFrom(
    data: Record<string, unknown>,
    columns: readonly string[]
): string {
    if (columns.length === 0)
        throw new Error('A key needs at least one column');
    return columns.map((c) => encodePart(data[c])).join(SEPARATOR);
}

/**
 * The row with new data, keyed from it. The partition key keeps as many
 * leading parts as the stored one has. Throws when the stored key is not
 * what `columns` rebuild, so a wrong column list never writes.
 */
export function rekey(
    row: StoredRow,
    data: Record<string, unknown>,
    columns: readonly string[],
    sortId: string | null = row.sort_id
): KvRow {
    if (keyFrom(row.row_data, columns) !== row.row_key) {
        throw new KeyMismatchError(row.table_name, row.row_key);
    }
    const rowKey = keyFrom(data, columns);
    const parts = row.partition_key.split(SEPARATOR).length;
    return {
        tableName: row.table_name,
        partitionKey: rowKey.split(SEPARATOR).slice(0, parts).join(SEPARATOR),
        rowKey,
        rowData: data,
        sortId,
    };
}

/** Primary key columns (Fluxer fluxer_api/src/api/Tables.ts). */
export const PRIMARY_KEYS: Readonly<Record<string, readonly string[]>> = {
    channels: ['channel_id', 'soft_deleted'],
    channel_state: ['channel_id'],
    channel_message_buckets: ['channel_id', 'bucket'],
    channel_empty_buckets: ['channel_id', 'bucket'],
    messages: ['channel_id', 'bucket', 'message_id'],
    message_reactions: [
        'channel_id',
        'bucket',
        'message_id',
        'emoji_id',
        'emoji_name',
        'user_id',
    ],
    channel_pins: ['channel_id', 'pinned_timestamp', 'message_id'],
    attachment_lookup: ['channel_id', 'attachment_id', 'filename'],
    messages_by_author_id_v2: ['author_id', 'message_id'],
    read_states: ['user_id', 'channel_id'],
    thread_state: ['thread_id'],
    thread_stats: ['thread_id'],
    threads_by_parent: ['parent_id', 'thread_id'],
    active_threads_by_guild: ['guild_id', 'thread_id'],
    archived_threads_by_parent: [
        'parent_id',
        'is_private',
        'archive_timestamp',
        'thread_id',
    ],
    thread_members: ['thread_id', 'user_id'],
    thread_members_by_user: [
        'user_id',
        'guild_id',
        'parent_id',
        'is_private',
        'thread_id',
    ],
    attachment_decay_by_id: ['attachment_id'],
    attachment_decay_by_expiry: [
        'expiry_bucket',
        'expires_at',
        'attachment_id',
    ],
};

export function primaryKey(table: string): readonly string[] {
    const columns = PRIMARY_KEYS[table];
    if (!columns) throw new Error(`No primary key known for ${table}`);
    return columns;
}

/** The bigint string a row_data field holds, or null. */
export function idOf(value: unknown): string | null {
    const v = (value as { value?: unknown } | null)?.value;
    return typeof v === 'string' ? v : null;
}
