import {
    DiscordAPIError,
    RESTJSONErrorCodes,
    type Client,
    type Guild,
    type GuildEmoji,
    type NonThreadGuildBasedChannel,
    type PermissionOverwrites,
    type Role,
    type Sticker,
} from 'discord.js';
import type { ReadResult } from '../health';
import type { SyncKind } from '../ops';
import type {
    ChannelSnap,
    EmojiSnap,
    GuildSnapshot,
    OverwriteSnap,
    RoleSnap,
    StickerSnap,
} from '../snapshot';
import {
    READ_TIMEOUT_MS,
    guardedLookup,
    guardedRead,
    type GuildReader,
} from './reader';

const UNKNOWN_CODES: ReadonlySet<unknown> = new Set([
    RESTJSONErrorCodes.UnknownChannel,
    RESTJSONErrorCodes.UnknownRole,
    RESTJSONErrorCodes.UnknownEmoji,
    RESTJSONErrorCodes.UnknownSticker,
]);

function isUnknown(error: unknown): boolean {
    return error instanceof DiscordAPIError && UNKNOWN_CODES.has(error.code);
}

function overwrite(o: PermissionOverwrites): OverwriteSnap {
    return {
        id: o.id,
        type: o.type === 1 ? 1 : 0,
        allow: o.allow.bitfield.toString(),
        deny: o.deny.bitfield.toString(),
    };
}

export function discordChannel(c: NonThreadGuildBasedChannel): ChannelSnap {
    return {
        id: c.id,
        type: c.type,
        name: c.name,
        position: c.rawPosition,
        parentId: c.parentId,
        topic: 'topic' in c ? (c.topic ?? null) : null,
        nsfw: 'nsfw' in c ? c.nsfw : false,
        rateLimitPerUser:
            'rateLimitPerUser' in c ? (c.rateLimitPerUser ?? 0) : 0,
        bitrate: 'bitrate' in c ? c.bitrate : null,
        userLimit: 'userLimit' in c ? c.userLimit : null,
        overwrites: c.permissionOverwrites.cache.map(overwrite),
    };
}

export function discordRole(r: Role): RoleSnap {
    return {
        id: r.id,
        name: r.name,
        color: r.colors.primaryColor,
        hoist: r.hoist,
        mentionable: r.mentionable,
        permissions: r.permissions.bitfield.toString(),
        position: r.rawPosition,
        managed: r.managed,
    };
}

const discordEmoji = (e: GuildEmoji): EmojiSnap => ({
    id: e.id,
    name: e.name ?? '',
    animated: e.animated ?? false,
});

const discordSticker = (s: Sticker): StickerSnap => ({
    id: s.id,
    name: s.name,
    description: s.description ?? '',
    tags: s.tags ?? '',
});

async function snapshotOf(guild: Guild): Promise<GuildSnapshot> {
    const force = { force: true };
    const [channels, roles, emojis, stickers] = await Promise.all([
        guild.channels.fetch(undefined, force),
        guild.roles.fetch(undefined, force),
        guild.emojis.fetch(undefined, force),
        guild.stickers.fetch(undefined, force),
    ]);
    return {
        side: 'discord',
        guildId: guild.id,
        name: guild.name,
        icon: guild.icon,
        banner: guild.banner,
        everyoneRoleId: guild.id,
        roles: roles.map(discordRole),
        channels: [...channels.values()]
            .filter((c): c is NonThreadGuildBasedChannel => c !== null)
            .map(discordChannel),
        emojis: emojis.map(discordEmoji),
        stickers: stickers.map(discordSticker),
        bot: null,
    };
}

/** Reads a Discord server's structure over REST. */
export class DiscordGuildReader implements GuildReader {
    constructor(
        private readonly client: Client,
        private readonly timeoutMs = READ_TIMEOUT_MS
    ) {}

    read(guildId: string): Promise<ReadResult> {
        return guardedRead('Discord read', this.timeoutMs, async () => {
            if (!this.client.isReady()) {
                return {
                    ok: false,
                    reason: 'not-ready',
                    detail: 'Discord gateway is not ready',
                };
            }
            const guild = await this.client.guilds.fetch({
                guild: guildId,
                force: true,
            });
            if (!guild.available) {
                return {
                    ok: false,
                    reason: 'unavailable',
                    detail: `Discord guild ${guildId} is unavailable`,
                };
            }
            return snapshotOf(guild);
        });
    }

    isGone(
        guildId: string,
        kind: SyncKind,
        id: string
    ): Promise<boolean | null> {
        return guardedLookup(
            this.timeoutMs,
            async () => {
                const guild = await this.client.guilds.fetch({
                    guild: guildId,
                    force: true,
                });
                return this.fetchOne(guild, kind, id);
            },
            isUnknown
        );
    }

    private fetchOne(
        guild: Guild,
        kind: SyncKind,
        id: string
    ): Promise<unknown> {
        const force = { force: true };
        switch (kind) {
            case 'role':
                return guild.roles.fetch(id, force);
            case 'category':
            case 'channel':
                return guild.channels.fetch(id, force);
            case 'emoji':
                return guild.emojis.fetch(id, force);
            case 'sticker':
                return guild.stickers.fetch(id, force);
            case 'guild':
                return Promise.resolve(guild);
        }
    }
}
