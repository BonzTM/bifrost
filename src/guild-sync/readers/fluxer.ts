import type {
    Client,
    Guild,
    GuildChannel,
    GuildEmoji,
    GuildSticker,
    Role,
} from '@fluxerjs/core';
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

/** Fluxer answers 404 for an unknown channel, role, emoji or sticker. */
function isUnknown(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    return (error as { statusCode?: unknown }).statusCode === 404;
}

/** Fields only some channel classes have. */
interface OptionalChannelFields {
    readonly topic?: string | null;
    readonly nsfw?: boolean;
    readonly rateLimitPerUser?: number;
    readonly bitrate?: number | null;
    readonly userLimit?: number | null;
}

export function fluxerChannel(c: GuildChannel): ChannelSnap {
    const extra = c as GuildChannel & OptionalChannelFields;
    const overwrites: OverwriteSnap[] = [];
    for (const o of c.permissionOverwrites) {
        overwrites.push({
            id: o.id,
            type: Number(o.type) === 1 ? 1 : 0,
            allow: o.allow.bitfield.toString(),
            deny: o.deny.bitfield.toString(),
        });
    }
    return {
        id: c.id,
        type: Number(c.type),
        name: c.name ?? '',
        position: c.position ?? 0,
        parentId: c.parentId,
        topic: extra.topic ?? null,
        nsfw: extra.nsfw ?? false,
        rateLimitPerUser: extra.rateLimitPerUser ?? 0,
        bitrate: extra.bitrate ?? null,
        userLimit: extra.userLimit ?? null,
        overwrites,
    };
}

export function fluxerRole(r: Role): RoleSnap {
    return {
        id: r.id,
        name: r.name,
        color: r.color,
        hoist: r.hoist,
        mentionable: r.mentionable,
        permissions: r.permissions.bitfield.toString(),
        position: r.position,
        // Fluxer has no managed roles.
        managed: false,
    };
}

const fluxerEmoji = (e: GuildEmoji): EmojiSnap => ({
    id: e.id,
    name: e.name,
    animated: e.animated,
});

const fluxerSticker = (s: GuildSticker): StickerSnap => ({
    id: s.id,
    name: s.name,
    description: s.description,
    tags: s.tags.join(','),
});

async function snapshotOf(guild: Guild): Promise<GuildSnapshot> {
    const [channels, roles, emojis, stickers, me] = await Promise.all([
        guild.fetchChannels(),
        guild.fetchRoles(),
        guild.fetchEmojis(),
        guild.fetchStickers(),
        guild.fetchMe(),
    ]);
    return {
        side: 'fluxer',
        guildId: guild.id,
        name: guild.name,
        icon: guild.icon,
        banner: guild.banner,
        everyoneRoleId: guild.id,
        roles: roles.map(fluxerRole),
        channels: channels.map(fluxerChannel),
        emojis: emojis.map(fluxerEmoji),
        stickers: stickers.map(fluxerSticker),
        bot: {
            userId: me.id,
            roleIds: [...me.roles.roleIds],
            isOwner: guild.ownerId === me.id,
        },
    };
}

/** Reads a Fluxer server's structure over REST. */
export class FluxerGuildReader implements GuildReader {
    /** Takes the client ref, because upstream replaces the client on restart. */
    constructor(
        private readonly clientRef: { readonly current: Client | null },
        private readonly timeoutMs = READ_TIMEOUT_MS
    ) {}

    read(guildId: string): Promise<ReadResult> {
        return guardedRead('Fluxer read', this.timeoutMs, async () => {
            const client = this.clientRef.current;
            if (!client?.isReady()) {
                return {
                    ok: false,
                    reason: 'not-ready',
                    detail: 'Fluxer gateway is not ready',
                };
            }
            const guild = await client.guilds.fetch(guildId, { force: true });
            if (!guild.available) {
                return {
                    ok: false,
                    reason: 'unavailable',
                    detail: `Fluxer guild ${guildId} is unavailable`,
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
        const client = this.clientRef.current;
        if (!client?.isReady()) return Promise.resolve(null);
        return guardedLookup(
            this.timeoutMs,
            async () => {
                const guild = await client.guilds.fetch(guildId, {
                    force: true,
                });
                return fetchOne(guild, kind, id);
            },
            isUnknown
        );
    }
}

function fetchOne(guild: Guild, kind: SyncKind, id: string): Promise<unknown> {
    switch (kind) {
        case 'role':
            return guild.fetchRole(id);
        case 'category':
        case 'channel':
            return guild.client.channels.fetch(id, { force: true });
        case 'emoji':
            return guild.fetchEmoji(id);
        case 'sticker':
            return guild.fetchSticker(id);
        case 'guild':
            return Promise.resolve(guild);
    }
}
