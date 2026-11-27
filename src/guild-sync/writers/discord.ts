import {
    ChannelFlags,
    ChannelType,
    type AnyThreadChannel,
    type Channel,
    type Client,
    type ThreadAutoArchiveDuration,
    type ThreadEditOptions,
} from 'discord.js';
import { timedWrite, type GuildWriter, type ThreadPatch } from './writer';

/**
 * Writes thread settings to Discord threads: a Fluxer edit of a synced
 * thread is written back (thread settings sync both ways, see
 * threadSettings.ts). Only threads; the server structure is never written
 * to Discord. Every method rejects on failure.
 */

/**
 * The auto-archive times Discord accepts, in minutes
 * (ThreadAutoArchiveDuration, discord-api-types payloads/v10/channel.d.ts:541).
 */
export const DISCORD_ARCHIVE_DURATIONS: ReadonlySet<number> = new Set([
    60, 1440, 4320, 10080,
]);

/** Forum and media channels: only their posts can be pinned or tagged. */
const POST_PARENTS: ReadonlySet<ChannelType> = new Set([
    ChannelType.GuildForum,
    ChannelType.GuildMedia,
]);

const isPost = (parent: Channel) => POST_PARENTS.has(parent.type);

/** The edits one patch needs, in the order they are sent. */
export interface EditPlan {
    /** Settings, with the archive flag when it can ride along. */
    readonly first: ThreadEditOptions;
    /** The pin flag, sent apart: Discord refuses a second pinned post. */
    readonly flags: ThreadEditOptions;
    /** True when the thread is archived again after the other edits. */
    readonly archiveAfter: boolean;
}

/**
 * Splits a patch into Discord edits. Discord refuses any edit to an
 * archived thread but its unarchive (InvalidActionOnArchivedThread 50083,
 * discord-api-types rest/common.d.ts:164), so an archived thread is
 * reopened in the first edit and archived again last, as the Fluxer writer
 * does (writers/fluxer.ts needsReopen). An open thread that is to be
 * archived takes the archive in the first edit unless a pin follows.
 */
export function editPlan(
    archived: boolean,
    settings: ThreadEditOptions,
    flags: ThreadEditOptions,
    wanted: boolean | undefined
): EditPlan {
    const touches =
        Object.keys(settings).length > 0 || flags.flags !== undefined;
    if (archived) {
        if (!touches) {
            const first = wanted === false ? { archived: false } : {};
            return { first, flags, archiveAfter: false };
        }
        const first = { ...settings, archived: false };
        return { first, flags, archiveAfter: wanted !== false };
    }
    if (wanted === true && flags.flags === undefined) {
        return {
            first: { ...settings, archived: true },
            flags,
            archiveAfter: false,
        };
    }
    return { first: settings, flags, archiveAfter: wanted === true };
}

/** The thread's flags with the pin set or cleared, or {} when unchanged. */
export function pinFlags(
    thread: Pick<AnyThreadChannel, 'flags'>,
    pinned: boolean | undefined
): ThreadEditOptions {
    if (pinned === undefined) return {};
    if (thread.flags.has(ChannelFlags.Pinned) === pinned) return {};
    const bits = thread.flags.bitfield;
    return {
        flags: pinned
            ? bits | ChannelFlags.Pinned
            : bits & ~ChannelFlags.Pinned,
    };
}

/** Sends one edit, unless it is empty. */
async function editIf(
    thread: AnyThreadChannel,
    label: string,
    edit: ThreadEditOptions
): Promise<void> {
    if (Object.keys(edit).length === 0) return;
    await timedWrite<AnyThreadChannel>(label, thread.edit(edit));
}

export class DiscordThreadWriter implements Pick<GuildWriter, 'updateThread'> {
    constructor(
        private readonly client: Pick<Client, 'channels'>,
        private readonly warn: (message: string) => void = () => {}
    ) {}

    async updateThread(
        guildId: string,
        threadId: string,
        patch: ThreadPatch
    ): Promise<void> {
        const thread = await this.thread(guildId, threadId);
        const parent = await this.parent(thread);
        const settings = this.settings(thread, parent, patch);
        if (patch.pinned !== undefined && !isPost(parent)) {
            throw new Error(
                `Discord thread ${threadId} is not a forum post; only posts are pinned`
            );
        }
        const plan = editPlan(
            thread.archived === true,
            settings,
            pinFlags(thread, patch.pinned),
            patch.archived
        );
        await editIf(thread, 'Discord thread edit', plan.first);
        try {
            await editIf(thread, 'Discord thread pin', plan.flags);
        } finally {
            if (plan.archiveAfter) {
                await timedWrite<AnyThreadChannel>(
                    'Discord thread re-archive',
                    thread.edit({ archived: true })
                );
            }
        }
    }

    /** The patch's settings in discord.js terms, archive and pin aside. */
    private settings(
        thread: AnyThreadChannel,
        parent: Channel,
        patch: ThreadPatch
    ): ThreadEditOptions {
        const edit: ThreadEditOptions = {};
        if (patch.name !== undefined) edit.name = patch.name;
        if (patch.locked !== undefined) edit.locked = patch.locked;
        if (patch.rateLimitPerUser !== undefined) {
            edit.rateLimitPerUser = patch.rateLimitPerUser;
        }
        const duration = patch.autoArchiveDuration;
        if (duration !== undefined && DISCORD_ARCHIVE_DURATIONS.has(duration)) {
            edit.autoArchiveDuration = duration as ThreadAutoArchiveDuration;
        } else if (duration !== undefined) {
            this.warn(
                `[guild-sync] Discord has no ${duration}-minute auto-archive; thread ${thread.id} keeps its own`
            );
        }
        // A thread outside a forum has no tags; an empty list is no edit.
        const tags = patch.tags ?? [];
        if (patch.tags !== undefined && (tags.length > 0 || isPost(parent))) {
            edit.appliedTags = this.tagIds(thread, parent, tags);
        }
        return edit;
    }

    /** Tag names as the forum's tag IDs. A name it lacks is skipped. */
    private tagIds(
        thread: AnyThreadChannel,
        parent: Channel,
        names: readonly string[]
    ): string[] {
        if (!('availableTags' in parent) || !isPost(parent)) {
            throw new Error(
                `Discord thread ${thread.id} is not a forum post; only posts are tagged`
            );
        }
        const ids: string[] = [];
        for (const name of names) {
            const tag = parent.availableTags.find((t) => t.name === name);
            if (tag) ids.push(tag.id);
            else {
                this.warn(
                    `[guild-sync] Discord forum ${parent.id} has no tag "${name}"; thread ${thread.id} goes without it`
                );
            }
        }
        return ids;
    }

    /** The thread, read fresh so its archive state is current. */
    private async thread(
        guildId: string,
        threadId: string
    ): Promise<AnyThreadChannel> {
        const channel = await this.client.channels.fetch(threadId, {
            force: true,
        });
        if (!channel?.isThread() || channel.guildId !== guildId) {
            throw new Error(
                `${threadId} is not a thread of Discord guild ${guildId}`
            );
        }
        return channel;
    }

    private async parent(thread: AnyThreadChannel): Promise<Channel> {
        if (!thread.parentId) {
            throw new Error(`Discord thread ${thread.id} has no parent`);
        }
        const parent = await this.client.channels.fetch(thread.parentId);
        if (!parent) {
            throw new Error(
                `the parent of Discord thread ${thread.id} is gone`
            );
        }
        return parent;
    }
}
