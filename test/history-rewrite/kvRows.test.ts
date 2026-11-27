import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    KeyMismatchError,
    encodePart,
    keyFrom,
    rekey,
} from '../../src/history-rewrite/kvRows';

// A channel_pins key read from the live Fluxer database on 2026-11-27.
const PIN_KEY =
    '{"__fluxer_type":"bigint","value":"1575322794562945024"}\u001f{"__fluxer_type":"date","value":"2026-11-26T18:15:10.978Z"}\u001f{"__fluxer_type":"bigint","value":"1575501535868092416"}';
// jsonb returns typed values with their keys reordered.
const PIN_DATA = {
    channel_id: { value: '1575322794562945024', __fluxer_type: 'bigint' },
    message_id: { value: '1575501535868092416', __fluxer_type: 'bigint' },
    pinned_timestamp: {
        value: '2026-11-26T18:15:10.978Z',
        __fluxer_type: 'date',
    },
};
const COLUMNS = ['channel_id', 'pinned_timestamp', 'message_id'];

describe('fluxer_kv keys', () => {
    it('rebuilds a stored key from jsonb row data', () => {
        assert.equal(keyFrom(PIN_DATA, COLUMNS), PIN_KEY);
    });

    it('encodes plain values as JSON', () => {
        assert.deepEqual(
            [
                encodePart(false),
                encodePart(434),
                encodePart('🦃'),
                encodePart(undefined),
            ],
            ['false', '434', '"🦃"', 'null']
        );
    });

    it('re-keys a row and keeps the partition length', () => {
        const row = {
            table_name: 'channel_pins',
            partition_key: PIN_KEY,
            row_key: PIN_KEY,
            row_data: PIN_DATA,
            sort_id: null,
        };
        const moved = rekey(
            row,
            {
                ...PIN_DATA,
                message_id: { __fluxer_type: 'bigint', value: '1' },
            },
            COLUMNS
        );
        assert.ok(
            moved.rowKey.endsWith('{"__fluxer_type":"bigint","value":"1"}')
        );
        assert.equal(moved.partitionKey, moved.rowKey);
    });

    it('refuses a column list that does not rebuild the stored key', () => {
        const row = {
            table_name: 'channel_pins',
            partition_key: PIN_KEY,
            row_key: PIN_KEY,
            row_data: PIN_DATA,
            sort_id: null,
        };
        assert.throws(
            () => rekey(row, PIN_DATA, ['channel_id', 'message_id']),
            KeyMismatchError
        );
    });
});
