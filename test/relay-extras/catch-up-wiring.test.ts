import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
    Channel as FluxerChannel,
    Client as FluxerClient,
    type ClientOptions,
} from '@fluxerjs/core';
import { MessageType, type Client as DiscordClient } from 'discord.js';
import { createRelayCatchUp, waitUntil } from '../../src/relay-extras/catchUp';
import {
    createCatchUpHooks,
    RelayGate,
} from '../../src/relay-extras/catchUp/gate';
import { fluxerSource } from '../../src/relay-extras/catchUp/sources';
import type { WebhookMessageData } from '../../src/services/WebhookService';
import {
    markFluxerApiBlocked,
    markFluxerApiOk,
} from '../../src/utils/fluxerApiGuard';
import { createRecordingLogger } from '../addons/fakes';
import {
    CONFIG,
    fakeClock,
    FakeStore,
    idAt,
    makeLink,
    NOW,
} from './catch-up-fakes';

/** Upstream's relay, loaded after the environment its logger reads. */
async function loadDiscordRelay() {
    process.env.BF_FLUXER_TOKEN ??= 'test-token';
    process.env.BF_DISCORD_TOKEN ??= 'test-token';
    process.env.BF_CONFIG_PATH ??= mkdtempSync(join(tmpdir(), 'bifrost-'));
    const module =
        await import('../../src/services/messageRelay/DiscordToFluxerMessageRelay');
    return module.default;
}

const LINK = { ...makeLink(), guildLinkId: 'gl', fluxerWebhookToken: 't' };

/** The real Discord-to-Fluxer relay over recording fakes. */
async function upstreamRelay() {
    const Relay = await loadDiscordRelay();
    const sent: string[] = [];
    const links: string[] = [];
    const deps = {
        linkService: {
            getChannelLinkByDiscordChannelId: async () => LINK,
            getGuildLinkById: async () => ({ id: 'gl', fluxerGuildId: 'fg' }),
            createMessageLink: async (l: { discordMessageId: string }) => {
                links.push(l.discordMessageId);
            },
        },
        webhookService: {
            getFluxerWebhook: async () => ({}),
            sendCopyViaFluxerWebhook: async (
                _hook: unknown,
                payload: WebhookMessageData
            ) => {
                sent.push(payload.content);
                return { ok: true, messageId: `f${sent.length}`, payload };
            },
        },
        messageTransformer: {
            transformMessage: async (m: { content: string }) => ({
                content: m.content,
                username: 'alice',
                avatarURL: '',
            }),
        },
        fluxerEntityResolver: { fetchEmojis: async () => [] },
    };
    const relay = new Relay(
        deps as unknown as ConstructorParameters<typeof Relay>[0]
    );
    return { relay, sent, links };
}

function discordMessage(id: string, content: string) {
    return {
        id,
        channelId: 'dc-1',
        author: { id: 'u1' },
        webhookId: null,
        content,
        type: MessageType.Default,
    };
}

/** A Discord client whose one channel lists `page`. */
function discordClient(page: ReturnType<typeof discordMessage>[]) {
    const channel = {
        isTextBased: () => true,
        isDMBased: () => false,
        isThread: () => false,
        messages: {
            fetch: async () => new Map(page.map((m) => [m.id, m])),
        },
    };
    return {
        isReady: () => true,
        user: { id: 'bot' },
        channels: { fetch: async () => channel },
    } as unknown as DiscordClient;
}

const fluxerRef = {
    current: {
        isReady: () => true,
        user: { id: 'fluxer-bot' },
        // No Fluxer channel: that side is skipped as unavailable.
        channels: { fetch: async () => null },
    } as unknown as FluxerClient,
};

describe('catch-up wiring', () => {
    it('relays through the same upstream relay as live messages', async () => {
        const { relay, sent, links } = await upstreamRelay();
        const store = new FakeStore();
        const time = fakeClock();
        const catchUp = createRelayCatchUp({
            config: CONFIG,
            store,
            bridged: async (_side, id) => links.includes(id),
            listLinks: async () => [LINK],
            commandPrefix: '!b ',
            startedAt: new Date(NOW - 60_000),
            logger: createRecordingLogger(),
            now: time.now,
            sleep: time.sleep,
            readyWaitMs: 0,
        });
        // As src/discord.ts and src/fluxer.ts bind them.
        const relayLive = catchUp.hooks.discord.bind(relay);
        catchUp.hooks.fluxer.bind({ relayMessage: async () => undefined });

        const live = discordMessage(idAt(NOW - 30_000), 'live');
        await relayLive(live as never);
        const missed = discordMessage(idAt(NOW - 120_000), 'missed');
        await catchUp.start({
            discordClient: discordClient([missed, live]),
            fluxerClientRef: fluxerRef,
        });

        assert.deepEqual(sent, ['live', 'missed']);
        assert.deepEqual(links, [live.id, missed.id]);
        assert.equal(catchUp.gate.isOpen, false);
    });

    it('closes the gate at once when catch-up is off', async () => {
        const catchUp = createRelayCatchUp({
            config: { ...CONFIG, enabled: false },
            store: new FakeStore(),
            bridged: async () => false,
            listLinks: async () => [],
            commandPrefix: '!b ',
            startedAt: new Date(NOW),
            logger: createRecordingLogger(),
        });
        assert.equal(catchUp.gate.isOpen, false);
    });

    it('skips catch-up when a client never gets ready', async () => {
        const logger = createRecordingLogger();
        const time = fakeClock();
        const catchUp = createRelayCatchUp({
            config: CONFIG,
            store: new FakeStore(),
            bridged: async () => false,
            listLinks: async () => [LINK],
            commandPrefix: '!b ',
            startedAt: new Date(NOW),
            logger,
            now: time.now,
            sleep: time.sleep,
            readyWaitMs: 3_000,
        });
        await catchUp.start({
            discordClient: discordClient([]),
            fluxerClientRef: { current: null },
        });
        assert.equal(catchUp.gate.isOpen, false);
        assert.match(logger.entries[0].message, /not both ready/);
        assert.equal(time.clock.slept.length, 3);
    });

    it('bounds the wait for readiness', async () => {
        const time = fakeClock();
        let calls = 0;
        const ready = await waitUntil(() => ++calls > 100, 5_000, time.sleep);
        assert.equal(ready, false);
        assert.equal(calls, 6);
    });
});

describe('catch-up Fluxer source', () => {
    const client = new FluxerClient({ intents: 0 } as ClientOptions);
    after(() => client.destroy());
    const channel = FluxerChannel.from(client, {
        id: 'fc-1',
        type: 0,
        guild_id: 'fg',
        name: 'general',
    } as unknown as Parameters<typeof FluxerChannel.from>[1]);

    it('lists messages after the cursor with their guild', async () => {
        const routes: string[] = [];
        const internals = client as unknown as {
            channels: { fetch: (id: string) => Promise<unknown> };
            rest: { get: (route: string) => Promise<unknown> };
        };
        internals.channels.fetch = async () => channel;
        internals.rest.get = async (route: string) => {
            routes.push(route);
            return [
                {
                    id: idAt(NOW),
                    channel_id: 'fc-1',
                    author: { id: 'u1', username: 'alice', discriminator: '0' },
                    content: 'hi',
                    timestamp: new Date(NOW).toISOString(),
                    edited_timestamp: null,
                    pinned: false,
                    attachments: [],
                    embeds: [],
                    mentions: [],
                    mention_roles: [],
                    mention_everyone: false,
                    tts: false,
                    type: 0,
                    flags: 0,
                },
            ];
        };
        const source = fluxerSource(
            { current: client },
            createCatchUpHooks(
                new RelayGate(async () => false, createRecordingLogger(), false)
            ).fluxer
        );
        const page = await source.fetchAfter('fc-1', '123', 50);
        assert.equal(page?.length, 1);
        assert.equal(page?.[0].guildId, 'fg');
        assert.equal(source.facts(page![0]).authorId, 'u1');
        assert.match(
            routes[0],
            /\/channels\/fc-1\/messages\?after=123&limit=50$/
        );
    });

    it('reads nothing while the Fluxer API blocks this IP', async () => {
        let reads = 0;
        const internals = client as unknown as {
            channels: { fetch: (id: string) => Promise<unknown> };
        };
        internals.channels.fetch = async () => {
            reads += 1;
            return channel;
        };
        const source = fluxerSource(
            { current: client },
            createCatchUpHooks(
                new RelayGate(async () => false, createRecordingLogger(), false)
            ).fluxer
        );
        markFluxerApiBlocked();
        try {
            await assert.rejects(source.fetchAfter('fc-1', '1', 10), /blocked/);
        } finally {
            markFluxerApiOk();
        }
        assert.equal(reads, 0);
    });

    it('returns null for a channel the relay does not copy', async () => {
        const internals = client as unknown as {
            channels: { fetch: (id: string) => Promise<unknown> };
        };
        internals.channels.fetch = async () => null;
        const source = fluxerSource(
            { current: client },
            createCatchUpHooks(
                new RelayGate(async () => false, createRecordingLogger(), false)
            ).fluxer
        );
        assert.equal(await source.fetchAfter('fc-1', '1', 10), null);
    });
});
