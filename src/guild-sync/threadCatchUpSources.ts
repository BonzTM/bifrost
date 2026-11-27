import {
    Message as FluxerMessage,
    Routes,
    type Client as FluxerClient,
} from '@fluxerjs/core';
import type { Client as DiscordClient, Message } from 'discord.js';
import {
    isFluxerApiBlockError,
    isFluxerApiBlocked,
    markFluxerApiBlocked,
} from '../utils/fluxerApiGuard';
import type { LinkedGuild } from './cycle';
import type {
    CatchUpThread,
    FoundMessage,
    ThreadCatchUpSource,
} from './threadCatchUp';
import { discordThreadMessage, isFluxerUserMessage } from './threadEvents';

/**
 * Where thread catch-up reads each platform. Messages pass the same skip
 * rules as live ones (threadEvents.ts).
 */

/** Bound on the guild links one run reads. */
export const MAX_CATCH_UP_GUILDS = 50;

type ListGuilds = () => Promise<readonly LinkedGuild[]>;

async function linkedGuilds(list: ListGuilds) {
    return (await list()).slice(0, MAX_CATCH_UP_GUILDS);
}

async function discordActive(
    client: DiscordClient,
    list: ListGuilds,
    limit: number
): Promise<CatchUpThread[]> {
    const out: CatchUpThread[] = [];
    for (const link of await linkedGuilds(list)) {
        const guild = await client.guilds.fetch(link.discordGuildId);
        const active = await guild.channels.fetchActiveThreads(false);
        for (const thread of active.threads.values()) {
            if (out.length >= limit) return out;
            if (!thread.parentId) continue;
            out.push({
                id: thread.id,
                parentId: thread.parentId,
                guildId: guild.id,
                lastMessageId: thread.lastMessageId ?? null,
            });
        }
    }
    return out;
}

async function discordAfter(
    client: DiscordClient,
    thread: CatchUpThread,
    afterId: string,
    limit: number,
    prefix: string
): Promise<FoundMessage[]> {
    const channel = await client.channels.fetch(thread.id);
    if (!channel?.isThread()) return [];
    const page = await channel.messages.fetch({
        after: afterId,
        limit,
        cache: false,
    });
    const found: FoundMessage[] = [];
    for (const message of page.values()) {
        const event = discordThreadMessage(
            message as Message,
            client.user?.id,
            prefix
        );
        if (event) found.push({ event, raw: message });
    }
    return found;
}

export function discordThreadSource(
    client: DiscordClient,
    list: ListGuilds,
    prefix: string
): ThreadCatchUpSource {
    return {
        side: 'discord',
        activeThreads: (limit) => discordActive(client, list, limit),
        messagesAfter: (thread, afterId, limit) =>
            discordAfter(client, thread, afterId, limit, prefix),
    };
}

/** Throws while the Fluxer API blocks this IP; starts the cooldown on one. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
    if (isFluxerApiBlocked()) throw new Error('Fluxer API blocked this IP');
    try {
        return await work();
    } catch (error) {
        if (isFluxerApiBlockError(error)) markFluxerApiBlocked();
        throw error;
    }
}

async function fluxerActive(
    client: FluxerClient,
    list: ListGuilds,
    limit: number
): Promise<CatchUpThread[]> {
    const out: CatchUpThread[] = [];
    for (const link of await linkedGuilds(list)) {
        const guild = await client.guilds.fetch(link.fluxerGuildId);
        const active = await guild.fetchActiveThreads();
        for (const thread of active.threads) {
            if (out.length >= limit) return out;
            if (!thread.parentId) continue;
            out.push({
                id: thread.id,
                parentId: thread.parentId,
                guildId: guild.id,
                lastMessageId: thread.lastMessageId ?? null,
            });
        }
    }
    return out;
}

type RawFluxerMessage = ConstructorParameters<typeof FluxerMessage>[1];

async function fluxerAfter(
    client: FluxerClient,
    thread: CatchUpThread,
    afterId: string,
    limit: number,
    prefix: string
): Promise<FoundMessage[]> {
    const query = new URLSearchParams({ after: afterId, limit: `${limit}` });
    const rows = await client.rest.get<RawFluxerMessage[]>(
        `${Routes.channelMessages(thread.id)}?${query.toString()}`
    );
    if (!Array.isArray(rows)) {
        throw new Error(`Fluxer returned no message list for ${thread.id}`);
    }
    const found: FoundMessage[] = [];
    for (const row of rows) {
        const message = new FluxerMessage(client, {
            ...row,
            guild_id: row.guild_id ?? thread.guildId,
        });
        if (!isFluxerUserMessage(message, client.user?.id, prefix)) continue;
        found.push({
            event: {
                id: message.id,
                channelId: thread.id,
                parentId: thread.parentId,
                webhookId: message.webhookId ?? null,
            },
            raw: message,
        });
    }
    return found;
}

export function fluxerThreadSource(
    clientRef: { readonly current: FluxerClient | null },
    list: ListGuilds,
    prefix: string
): ThreadCatchUpSource {
    const client = (): FluxerClient => {
        if (!clientRef.current) throw new Error('Fluxer client is not up');
        return clientRef.current;
    };
    return {
        side: 'fluxer',
        activeThreads: (limit) =>
            guarded(() => fluxerActive(client(), list, limit)),
        messagesAfter: (thread, afterId, limit) =>
            guarded(() =>
                fluxerAfter(client(), thread, afterId, limit, prefix)
            ),
    };
}
