import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PermissionFlags } from '@fluxerjs/util';
import { PermissionFlagsBits } from 'discord.js';
import { compareFields, diff, type DiffInput } from '../../src/guild-sync/diff';
import type { PlanOp } from '../../src/guild-sync/ops';
import type { ThreadSnap } from '../../src/guild-sync/snapshot';
import { compareThread } from '../../src/guild-sync/threadSettings';
import {
    D_GUILD,
    F_GUILD,
    channel,
    discordGuild,
    fluxerGuild,
    mapRow,
    role,
} from './fixtures';

const bits = (value: bigint) => value.toString();

function input(overrides: Partial<DiffInput> = {}): DiffInput {
    return {
        source: discordGuild(),
        destination: fluxerGuild(),
        previousSource: null,
        rows: [],
        direction: 'discord-to-fluxer',
        ...overrides,
    };
}

const opsOf = (result: ReturnType<typeof diff>, op: PlanOp['op']) =>
    result.ops.filter((o) => o.op === op);

describe('compareFields', () => {
    it('treats a moved source value as a change and the rest as drift', () => {
        const result = compareFields(
            { name: 'new', topic: 'a' },
            { name: 'old', topic: 'edited' },
            { name: 'old', topic: 'a' }
        );
        assert.deepEqual(result.changes, [
            { field: 'name', from: 'old', to: 'new' },
        ]);
        assert.deepEqual(result.drifted, ['topic']);
    });

    it('reports drift when there is no earlier snapshot', () => {
        const result = compareFields({ name: 'a' }, { name: 'b' }, null);
        assert.deepEqual(result, {
            changes: [],
            drifted: ['name'],
            settled: {},
        });
    });
});

describe('diff', () => {
    it('creates every unmapped source object, @everyone excepted', () => {
        const result = diff(
            input({
                source: discordGuild({
                    roles: [role(D_GUILD), role('r1')],
                    channels: [
                        channel('cat', { type: 4 }),
                        channel('c1', { parentId: 'cat' }),
                    ],
                    emojis: [{ id: 'e1', name: 'wave', animated: false }],
                }),
            })
        );
        const created = opsOf(result, 'create').map(
            (o) => `${o.kind}:${o.op === 'create' ? o.sourceId : ''}`
        );
        assert.deepEqual(created, [
            'role:r1',
            'category:cat',
            'channel:c1',
            'emoji:e1',
        ]);
    });

    it('points a create at an unmapped destination object with the same name', () => {
        const result = diff(
            input({
                source: discordGuild({
                    channels: [channel('c1', { name: 'general' })],
                }),
                destination: fluxerGuild({
                    channels: [channel('f1', { name: 'general' })],
                }),
            })
        );
        assert.deepEqual(opsOf(result, 'create'), [
            {
                op: 'create',
                kind: 'channel',
                sourceId: 'c1',
                name: 'general',
                existingDestId: 'f1',
            },
        ]);
    });

    it('updates a renamed source channel', () => {
        const previous = discordGuild({
            channels: [channel('c1', { name: 'old' })],
        });
        const result = diff(
            input({
                source: discordGuild({
                    channels: [channel('c1', { name: 'new' })],
                }),
                destination: fluxerGuild({
                    channels: [channel('f1', { name: 'old' })],
                }),
                previousSource: previous,
                rows: [mapRow('channel', 'c1', 'f1')],
            })
        );
        const [update] = opsOf(result, 'update');
        assert.ok(update?.op === 'update');
        assert.deepEqual(update.changes, [
            { field: 'name', from: 'old', to: 'new' },
        ]);
        assert.equal(update.settled?.name, 'new');
    });

    it('reports a destination edit as drift and does not revert it', () => {
        const source = discordGuild({
            channels: [channel('c1', { name: 'same' })],
        });
        const result = diff(
            input({
                source,
                destination: fluxerGuild({
                    channels: [channel('f1', { name: 'hand-edit' })],
                }),
                previousSource: source,
                rows: [mapRow('channel', 'c1', 'f1')],
            })
        );
        assert.equal(opsOf(result, 'update').length, 0);
        assert.equal(
            result.findings.filter((f) => f.type === 'drift').length,
            1
        );
    });

    it('re-parents a channel into the mapped category', () => {
        const prev = discordGuild({
            channels: [
                channel('cat', { type: 4 }),
                channel('c1', { parentId: null }),
            ],
        });
        const result = diff(
            input({
                source: discordGuild({
                    channels: [
                        channel('cat', { type: 4 }),
                        channel('c1', { parentId: 'cat' }),
                    ],
                }),
                destination: fluxerGuild({
                    channels: [
                        channel('fcat', { type: 4, name: 'channel-cat' }),
                        channel('f1', { name: 'channel-c1' }),
                    ],
                }),
                previousSource: prev,
                rows: [
                    mapRow('category', 'cat', 'fcat'),
                    mapRow('channel', 'c1', 'f1'),
                ],
            })
        );
        const update = opsOf(result, 'update')[0];
        assert.ok(update && update.op === 'update');
        assert.deepEqual(update.changes, [
            { field: 'parentId', from: null, to: 'fcat' },
        ]);
    });

    it('translates overwrites through mapped role IDs and drops Discord-only bits', () => {
        const allow =
            PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendPolls;
        const ow = (id: string, a: bigint) => ({
            id,
            type: 0 as const,
            allow: bits(a),
            deny: '0',
        });
        // @everyone can view, so no private-by-default deny is added.
        const everyone = role(D_GUILD, {
            permissions: bits(PermissionFlagsBits.ViewChannel),
        });
        const prev = discordGuild({
            roles: [everyone, role('r1')],
            channels: [channel('c1')],
        });
        const result = diff(
            input({
                source: discordGuild({
                    roles: [everyone, role('r1')],
                    channels: [
                        channel('c1', { overwrites: [ow('r1', allow)] }),
                    ],
                }),
                destination: fluxerGuild({
                    roles: [role(F_GUILD), role('fr1', { name: 'role-r1' })],
                    channels: [channel('f1', { name: 'channel-c1' })],
                }),
                previousSource: prev,
                rows: [
                    mapRow('role', 'r1', 'fr1'),
                    mapRow('channel', 'c1', 'f1'),
                ],
            })
        );
        const update = opsOf(result, 'update').find(
            (o) => o.kind === 'channel'
        );
        assert.ok(update && update.op === 'update');
        assert.deepEqual(update.changes, [
            {
                field: 'overwrites',
                from: [],
                to: [
                    {
                        id: 'fr1',
                        allow: bits(PermissionFlags.ViewChannel),
                        deny: '0',
                    },
                ],
            },
        ]);
    });

    it('reorders mapped roles when the source order changed', () => {
        const roles = (a: number, b: number) => [
            role(D_GUILD),
            role('r1', { position: a }),
            role('r2', { position: b }),
        ];
        const result = diff(
            input({
                source: discordGuild({ roles: roles(2, 1) }),
                previousSource: discordGuild({ roles: roles(1, 2) }),
                destination: fluxerGuild({
                    roles: [
                        role(F_GUILD),
                        role('f1', { name: 'role-r1', position: 1 }),
                        role('f2', { name: 'role-r2', position: 2 }),
                    ],
                }),
                rows: [mapRow('role', 'r1', 'f1'), mapRow('role', 'r2', 'f2')],
            })
        );
        assert.deepEqual(opsOf(result, 'reorder'), [
            {
                op: 'reorder',
                kind: 'role',
                scope: 'roles',
                destIds: ['f2', 'f1'],
            },
        ]);
    });

    it('updates only the permissions of @everyone', () => {
        const prev = discordGuild();
        const result = diff(
            input({
                source: discordGuild({
                    roles: [
                        role(D_GUILD, {
                            name: 'renamed',
                            permissions: bits(PermissionFlagsBits.SendMessages),
                        }),
                    ],
                }),
                previousSource: prev,
            })
        );
        const update = opsOf(result, 'update')[0];
        assert.ok(update && update.op === 'update');
        assert.equal(update.destId, F_GUILD);
        assert.deepEqual(
            update.changes.map((c) => c.field),
            ['permissions']
        );
    });

    it('skips managed roles and unsynced channel types', () => {
        const result = diff(
            input({
                source: discordGuild({
                    roles: [role(D_GUILD), role('bot', { managed: true })],
                    // Type 14 is a Discord directory channel.
                    channels: [channel('c1'), channel('dir', { type: 14 })],
                }),
            })
        );
        const skipped = result.findings
            .filter((f) => f.type === 'skipped')
            .map((f) => f.id);
        assert.deepEqual(skipped, ['bot', 'dir']);
        assert.ok(
            !result.ops.some(
                (o) => o.op === 'create' && ['bot', 'dir'].includes(o.sourceId)
            )
        );
    });

    it('never plans an op on an unmapped destination object', () => {
        const result = diff(
            input({
                destination: fluxerGuild({
                    roles: [role(F_GUILD), role('stray')],
                    channels: [channel('f-stray')],
                }),
            })
        );
        const touched = result.ops.flatMap((o) =>
            o.op === 'reorder' ? o.destIds : o.op === 'create' ? [] : [o.destId]
        );
        assert.ok(!touched.includes('stray') && !touched.includes('f-stray'));
    });

    it('reports grants the destination bot does not hold', () => {
        const result = diff(
            input({
                source: discordGuild({
                    roles: [
                        role(D_GUILD),
                        role('r1', {
                            permissions: bits(PermissionFlagsBits.BanMembers),
                        }),
                    ],
                }),
                destination: fluxerGuild({
                    bot: { userId: 'bot', roleIds: [], isOwner: false },
                }),
            })
        );
        const finding = result.findings.find(
            (f) => f.type === 'not-held-by-bot'
        );
        assert.ok(finding);
        assert.match(finding.detail, /BanMembers/);
    });

    it('reports a source category over the destination limit', () => {
        const children = Array.from({ length: 51 }, (_, i) =>
            channel(`c${i}`, { parentId: 'cat' })
        );
        const result = diff(
            input({
                source: discordGuild({
                    channels: [channel('cat', { type: 4 }), ...children],
                }),
            })
        );
        assert.ok(
            result.findings.some(
                (f) => f.type === 'category-full' && f.id === 'cat'
            )
        );
    });
});

describe('thread settings, both ways', () => {
    /** The post as both sides had it when the sync last wrote it. */
    const look = {
        name: 'Patch notes',
        archived: false,
        locked: false,
        tags: ['news'],
        private: false,
        pinned: false,
        rateLimitPerUser: 0,
        autoArchiveDuration: 1440,
    };

    /** A synced post (or a thread in a text channel) and its copy. */
    function pair(
        source: Partial<ThreadSnap>,
        dest: Partial<ThreadSnap>,
        options: { where?: 'forum' | 'text'; fluxerTags?: string[] } = {}
    ): DiffInput {
        const where = options.where ?? 'forum';
        const forum = { type: 15, tags: ['news', 'help'] };
        return input({
            source: discordGuild({
                channels: [channel('d-forum', forum), channel('d-text')],
                threads: [
                    {
                        id: 'd-post',
                        parentId: `d-${where}`,
                        ...look,
                        ...source,
                    },
                ],
            }),
            destination: fluxerGuild({
                channels: [
                    channel('f-forum', {
                        ...forum,
                        tags: options.fluxerTags ?? forum.tags,
                    }),
                    channel('f-text'),
                ],
                threads: [
                    { id: 'f-post', parentId: `f-${where}`, ...look, ...dest },
                ],
            }),
            rows: [
                mapRow('channel', 'd-forum', 'f-forum'),
                mapRow('channel', 'd-text', 'f-text'),
                mapRow('thread', 'd-post', 'f-post', {
                    appliedFields: { ...look, parentId: `f-${where}` },
                }),
            ],
        });
    }

    const threadOps = (result: ReturnType<typeof diff>) =>
        result.ops.filter((op) => op.kind === 'thread');
    const findingsOf = (result: ReturnType<typeof diff>) =>
        result.findings.filter((f) => f.kind === 'thread');

    it('writes a Fluxer edit back to Discord, with no drift', () => {
        const result = diff(
            pair({}, { name: 'Renamed on Fluxer', archived: true })
        );
        const [op, ...rest] = threadOps(result);
        assert.deepEqual(rest, []);
        assert.ok(op?.op === 'write-back');
        assert.equal(op.sourceId, 'd-post');
        assert.equal(op.destId, 'f-post');
        assert.deepEqual(op.changes, [
            { field: 'name', from: 'Patch notes', to: 'Renamed on Fluxer' },
            { field: 'archived', from: false, to: true },
        ]);
        assert.equal(op.settled.name, 'Renamed on Fluxer');
        assert.equal(op.settled.locked, false);
        assert.deepEqual(findingsOf(result), []);
    });

    it('keeps Discord’s value when both sides changed a setting differently', () => {
        const result = diff(
            pair({ name: 'Renamed on Discord' }, { name: 'Renamed on Fluxer' })
        );
        const [op, ...rest] = threadOps(result);
        assert.deepEqual(rest, []);
        assert.ok(op?.op === 'update');
        assert.deepEqual(op.changes, [
            {
                field: 'name',
                from: 'Renamed on Fluxer',
                to: 'Renamed on Discord',
            },
        ]);
        const [finding] = findingsOf(result);
        assert.equal(finding?.type, 'conflict');
        assert.match(finding.detail, /both sides.*name/);
    });

    it('carries each side’s own edits when they touch different settings', () => {
        const result = diff(pair({ name: 'Renamed' }, { locked: true }));
        const ops = threadOps(result);
        assert.deepEqual(
            ops.map((op) => [
                op.op,
                op.op === 'update' || op.op === 'write-back'
                    ? op.changes.map((c) => c.field)
                    : [],
            ]),
            [
                ['update', ['name']],
                ['write-back', ['locked']],
            ]
        );
        // Neither base takes the other side's pending edit.
        const [update, back] = ops;
        assert.ok(update.op === 'update' && back.op === 'write-back');
        assert.equal(update.settled?.locked, undefined);
        assert.equal(back.settled.name, undefined);
    });

    it('only records a value both sides changed alike', () => {
        const result = diff(pair({ archived: true }, { archived: true }));
        const [op, ...rest] = threadOps(result);
        assert.deepEqual(rest, []);
        assert.ok(op?.op === 'write-back');
        assert.deepEqual(op.changes, []);
        assert.equal(op.settled.archived, true);
        assert.deepEqual(findingsOf(result), []);
    });

    it('plans nothing once the base holds what both sides agree on', () => {
        const agreed = pair({ archived: true }, { archived: true });
        const rows = agreed.rows.map((row) =>
            row.kind === 'thread'
                ? {
                      ...row,
                      appliedFields: {
                          ...look,
                          archived: true,
                          parentId: 'f-forum',
                      },
                  }
                : row
        );
        assert.deepEqual(threadOps(diff({ ...agreed, rows })), []);
    });

    it('never reverts a Fluxer edit with enforce on', () => {
        const result = diff({
            ...pair({}, { locked: true, rateLimitPerUser: 30 }),
            enforceDrift: true,
        });
        const [op, ...rest] = threadOps(result);
        assert.deepEqual(rest, []);
        assert.ok(op?.op === 'write-back');
        assert.deepEqual(
            op.changes.map((c) => c.field),
            ['locked', 'rateLimitPerUser']
        );
    });

    it('reports a pin outside a forum as drift', () => {
        const result = diff(pair({}, { pinned: true }, { where: 'text' }));
        assert.deepEqual(threadOps(result), []);
        const [finding] = findingsOf(result);
        assert.equal(finding?.type, 'drift');
        assert.match(finding.detail, /pinned/);
    });

    it('writes tags back only while both forums offer every tag', () => {
        const extra = pair(
            {},
            { tags: ['fluxer-only', 'news'] },
            { fluxerTags: ['news', 'help', 'fluxer-only'] }
        );
        assert.deepEqual(threadOps(diff(extra)), []);
        assert.equal(findingsOf(diff(extra))[0]?.type, 'drift');
        const shared = diff(pair({}, { tags: ['help', 'news'] }));
        const [op] = threadOps(shared);
        assert.ok(op?.op === 'write-back');
        assert.deepEqual(op.changes, [
            { field: 'tags', from: ['news'], to: ['help', 'news'] },
        ]);
    });

    it('holds write-backs while the thread’s history import runs', () => {
        const result = diff({
            ...pair({ name: 'Renamed' }, { archived: true }),
            importing: new Set(['d-post']),
        });
        assert.deepEqual(
            threadOps(result).map((op) => op.op),
            ['update']
        );
        const [finding] = findingsOf(result);
        assert.equal(finding?.type, 'skipped');
        assert.match(finding.detail, /archived.*history import/);
    });
});

describe('compareThread', () => {
    const all = new Set(['name', 'locked']);

    it('reports a difference as drift when there is no base', () => {
        const result = compareThread({ name: 'a' }, { name: 'b' }, null, all);
        assert.deepEqual(result.forward, []);
        assert.deepEqual(result.back, []);
        assert.deepEqual(result.drifted, ['name']);
    });

    it('follows the source for a field the base lacks', () => {
        const result = compareThread({ name: 'a' }, { name: 'b' }, {}, all);
        assert.deepEqual(result.forward, [
            { field: 'name', from: 'b', to: 'a' },
        ]);
        assert.deepEqual(result.conflicts, []);
    });

    it('reports a destination edit it may not write back as drift', () => {
        const result = compareThread(
            { invitable: true },
            { invitable: false },
            { invitable: true },
            all
        );
        assert.deepEqual(result.back, []);
        assert.deepEqual(result.drifted, ['invitable']);
    });
});
