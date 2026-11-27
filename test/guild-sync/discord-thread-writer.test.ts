import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    ChannelFlags,
    ChannelFlagsBitField,
    ChannelType,
    type Client,
    type ThreadEditOptions,
} from 'discord.js';
import {
    DiscordThreadWriter,
    editPlan,
} from '../../src/guild-sync/writers/discord';

const GUILD = 'd-guild';

interface FakeThreadState {
    archived: boolean;
    pinned?: boolean;
    parentType?: ChannelType;
    /** Edits that throw, by the first field they carry. */
    refuse?: string;
}

/** A Discord client with one thread in one forum (or text channel). */
function fakeDiscord(state: FakeThreadState) {
    const edits: ThreadEditOptions[] = [];
    const thread = {
        id: 'd-post',
        guildId: GUILD,
        parentId: 'd-forum',
        archived: state.archived,
        flags: new ChannelFlagsBitField(
            state.pinned ? ChannelFlags.Pinned : 0
        ).freeze(),
        isThread: () => true,
        async edit(options: ThreadEditOptions) {
            const [first] = Object.keys(options);
            if (state.refuse !== undefined && first === state.refuse) {
                throw new Error(`refused ${first}`);
            }
            edits.push(options);
            return thread;
        },
    };
    const parent = {
        id: 'd-forum',
        type: state.parentType ?? ChannelType.GuildForum,
        availableTags: [
            { id: 't-news', name: 'news' },
            { id: 't-help', name: 'help' },
        ],
    };
    const channels = new Map<string, unknown>([
        [thread.id, thread],
        [parent.id, parent],
    ]);
    const client = {
        channels: { fetch: async (id: string) => channels.get(id) ?? null },
    } as unknown as Pick<Client, 'channels'>;
    const warnings: string[] = [];
    const writer = new DiscordThreadWriter(client, (m) => warnings.push(m));
    return { writer, edits, warnings };
}

describe('DiscordThreadWriter', () => {
    it('reopens an archived thread for an edit and archives it again', async () => {
        const d = fakeDiscord({ archived: true });
        await d.writer.updateThread(GUILD, 'd-post', {
            name: 'Renamed on Fluxer',
        });
        assert.deepEqual(d.edits, [
            { name: 'Renamed on Fluxer', archived: false },
            { archived: true },
        ]);
    });

    it('leaves an archived thread open when the patch reopens it', async () => {
        const d = fakeDiscord({ archived: true });
        await d.writer.updateThread(GUILD, 'd-post', {
            archived: false,
            locked: false,
        });
        assert.deepEqual(d.edits, [{ locked: false, archived: false }]);
    });

    it('archives an open thread in the same edit as its other settings', async () => {
        const d = fakeDiscord({ archived: false });
        await d.writer.updateThread(GUILD, 'd-post', {
            archived: true,
            rateLimitPerUser: 30,
        });
        assert.deepEqual(d.edits, [{ rateLimitPerUser: 30, archived: true }]);
    });

    it('maps tag names to the forum’s tag IDs and skips unknown ones', async () => {
        const d = fakeDiscord({ archived: false });
        await d.writer.updateThread(GUILD, 'd-post', {
            tags: ['help', 'fluxer-only'],
        });
        assert.deepEqual(d.edits, [{ appliedTags: ['t-help'] }]);
        assert.equal(d.warnings.length, 1);
        assert.match(d.warnings[0], /no tag "fluxer-only"/);
    });

    it('pins a post in its own edit, then archives it again', async () => {
        const d = fakeDiscord({ archived: true });
        await d.writer.updateThread(GUILD, 'd-post', {
            locked: true,
            pinned: true,
        });
        assert.deepEqual(d.edits, [
            { locked: true, archived: false },
            { flags: ChannelFlags.Pinned },
            { archived: true },
        ]);
    });

    it('unpins a pinned post', async () => {
        const d = fakeDiscord({ archived: false, pinned: true });
        await d.writer.updateThread(GUILD, 'd-post', { pinned: false });
        assert.deepEqual(d.edits, [{ flags: 0 }]);
    });

    it('archives the thread again when the pin is refused', async () => {
        const d = fakeDiscord({ archived: true, refuse: 'flags' });
        await assert.rejects(
            d.writer.updateThread(GUILD, 'd-post', { name: 'x', pinned: true }),
            /refused flags/
        );
        assert.deepEqual(d.edits, [
            { name: 'x', archived: false },
            { archived: true },
        ]);
    });

    it('refuses to pin a thread outside a forum', async () => {
        const d = fakeDiscord({
            archived: false,
            parentType: ChannelType.GuildText,
        });
        await assert.rejects(
            d.writer.updateThread(GUILD, 'd-post', { pinned: true }),
            /not a forum post/
        );
        assert.deepEqual(d.edits, []);
    });

    it('keeps its own auto-archive when Discord has no such choice', async () => {
        const d = fakeDiscord({ archived: false });
        await d.writer.updateThread(GUILD, 'd-post', {
            autoArchiveDuration: 720,
            name: 'kept',
        });
        assert.deepEqual(d.edits, [{ name: 'kept' }]);
        assert.match(d.warnings[0], /720-minute/);
    });

    it('refuses a thread of another guild', async () => {
        const d = fakeDiscord({ archived: false });
        await assert.rejects(
            d.writer.updateThread('other', 'd-post', { name: 'x' }),
            /not a thread of Discord guild other/
        );
    });
});

describe('editPlan', () => {
    it('sends nothing to an archived thread a patch leaves archived', () => {
        assert.deepEqual(editPlan(true, {}, {}, true), {
            first: {},
            flags: {},
            archiveAfter: false,
        });
    });

    it('archives an open thread last when a pin goes first', () => {
        const flags = { flags: ChannelFlags.Pinned };
        assert.deepEqual(editPlan(false, { name: 'x' }, flags, true), {
            first: { name: 'x' },
            flags,
            archiveAfter: true,
        });
    });
});
