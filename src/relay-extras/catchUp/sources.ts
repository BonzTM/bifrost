import {
    Message as FluxerMessage,
    Routes,
    type Client as FluxerClient,
} from '@fluxerjs/core';
import { MessageType, type Client as DiscordClient } from 'discord.js';
import {
    isFluxerApiBlockError,
    isFluxerApiBlocked,
    markFluxerApiBlocked,
} from '../../utils/fluxerApiGuard';
import { isRelayedDiscordChannel, isRelayedFluxerChannel } from '../channels';
import type { Side } from '../types';
import type { DiscordRelayMessage, SideRelay } from './gate';
import type { Candidate } from './select';

/**
 * Where catch-up reads one side's missed messages, and where it sends
 * them: the live relay bound in src/discord.ts or src/fluxer.ts.
 */
export interface CatchUpSource<M> {
    readonly side: Side;
    /** This side's bot user, or null while it is unknown. */
    botUserId(): string | null;
    /**
     * At most `limit` messages posted after `afterId`, in any order. Null
     * when the channel is not one the live relay copies (src/relay-extras/
     * channels.ts), so its messages were never relayed either.
     */
    fetchAfter(
        channelId: string,
        afterId: string,
        limit: number
    ): Promise<M[] | null>;
    facts(message: M): Candidate;
    relay(message: M): Promise<void>;
}

/** Message type 7 is a join notice on both platforms. */
const JOIN_TYPE = 7;

export function discordFacts(message: DiscordRelayMessage): Candidate {
    return {
        id: message.id,
        authorId: message.author.id,
        webhookId: message.webhookId ?? null,
        content: message.content ?? '',
        isJoin: message.type === MessageType.UserJoin,
    };
}

/**
 * `after` returns the messages right after the cursor: the history add-on
 * walks channels forward the same way (src/guild-sync/upstreamBridge.ts
 * :929-942, src/history/importer.ts:1358-1372).
 */
async function fetchDiscordAfter(
    client: DiscordClient,
    channelId: string,
    afterId: string,
    limit: number
): Promise<DiscordRelayMessage[] | null> {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !isRelayedDiscordChannel(channel)) return null;
    if (!channel.isTextBased() || channel.isDMBased()) return null;
    const page = await channel.messages.fetch({
        after: afterId,
        limit,
        cache: false,
    });
    return [...page.values()];
}

export function discordSource(
    client: DiscordClient,
    relay: SideRelay<DiscordRelayMessage>
): CatchUpSource<DiscordRelayMessage> {
    return {
        side: 'discord',
        botUserId: () => client.user?.id ?? null,
        fetchAfter: (channelId, afterId, limit) =>
            fetchDiscordAfter(client, channelId, afterId, limit),
        facts: discordFacts,
        relay: (message) => relay.relay(message),
    };
}

export function fluxerFacts(message: FluxerMessage): Candidate {
    return {
        id: message.id,
        authorId: message.author.id,
        webhookId: message.webhookId ?? null,
        content: message.content ?? '',
        isJoin: message.type === JOIN_TYPE,
    };
}

type RawFluxerMessage = ConstructorParameters<typeof FluxerMessage>[1];

/**
 * Builds Message objects from the raw list, as MessageManager.fetch does
 * (@fluxerjs/core 3.3.0 dist/index.js:2288-2303), with the channel's
 * guild when a row has none. The relay's fidelity finds the guild link by
 * the message's guild (src/relay-extras/fidelity/service.ts:141); Discord
 * leaves guild_id out of REST messages, and this code does not assume
 * Fluxer keeps it.
 */
async function fetchFluxerAfter(
    client: FluxerClient,
    channelId: string,
    afterId: string,
    limit: number
): Promise<FluxerMessage[] | null> {
    const channel = await client.channels.fetch(channelId);
    if (!isRelayedFluxerChannel(channel)) return null;
    const query = new URLSearchParams({ after: afterId, limit: `${limit}` });
    const rows = await client.rest.get<RawFluxerMessage[]>(
        `${Routes.channelMessages(channelId)}?${query.toString()}`
    );
    if (!Array.isArray(rows)) {
        throw new Error(`Fluxer returned no message list for ${channelId}`);
    }
    return rows.map(
        (row) =>
            new FluxerMessage(client, {
                ...row,
                guild_id: row.guild_id ?? channel.guildId,
            })
    );
}

/**
 * Reads nothing while the Fluxer API has blocked this IP, and starts that
 * cooldown on a block error, as the upstream relay does
 * (DiscordToFluxerMessageRelay :84, :125).
 */
async function guardedFluxerFetch(
    client: FluxerClient,
    channelId: string,
    afterId: string,
    limit: number
): Promise<FluxerMessage[] | null> {
    if (isFluxerApiBlocked()) throw new Error('Fluxer API blocked this IP');
    try {
        return await fetchFluxerAfter(client, channelId, afterId, limit);
    } catch (error) {
        if (isFluxerApiBlockError(error)) markFluxerApiBlocked();
        throw error;
    }
}

export function fluxerSource(
    clientRef: { readonly current: FluxerClient | null },
    relay: SideRelay<FluxerMessage>
): CatchUpSource<FluxerMessage> {
    const client = (): FluxerClient => {
        if (!clientRef.current) throw new Error('Fluxer client is not up');
        return clientRef.current;
    };
    return {
        side: 'fluxer',
        botUserId: () => clientRef.current?.user?.id ?? null,
        fetchAfter: (channelId, afterId, limit) =>
            guardedFluxerFetch(client(), channelId, afterId, limit),
        facts: fluxerFacts,
        relay: (message) => relay.relay(message),
    };
}
