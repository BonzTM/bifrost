import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Events, type Client as DiscordClient } from 'discord.js';
import type { Client as FluxerClient } from '@fluxerjs/core';
import type { Sequelize } from 'sequelize';
import type { Addon, AddonContext } from '../addons/host';
import { runCycle, type CycleDeps, type LinkedGuild } from './cycle';
import { DiscordGuildReader } from './readers/discord';
import { FluxerGuildReader } from './readers/fluxer';
import { DEFAULT_SCHEDULE, SyncScheduler } from './scheduler';
import { PostgresGuildSyncStore, type GuildSyncStore } from './store';

export const ADDON_NAME = 'guild-sync';

/** Upper bound on guild links one run walks through. */
export const MAX_LINKS_PER_RUN = 50;

/** Snapshots are kept 30 days (design: Data model). */
const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Discord events that schedule a cycle (design: Triggers). */
const SOURCE_EVENTS = [
    Events.ChannelCreate,
    Events.ChannelUpdate,
    Events.ChannelDelete,
    Events.GuildRoleCreate,
    Events.GuildRoleUpdate,
    Events.GuildRoleDelete,
    Events.GuildEmojiCreate,
    Events.GuildEmojiUpdate,
    Events.GuildEmojiDelete,
    Events.GuildStickerCreate,
    Events.GuildStickerUpdate,
    Events.GuildStickerDelete,
    Events.GuildUpdate,
] as const;

export interface GuildSyncDeps {
    readonly discordClient: DiscordClient;
    readonly fluxerClientRef: { readonly current: FluxerClient | null };
    readonly listGuildLinks: () => Promise<readonly LinkedGuild[]>;
    readonly sequelize: Sequelize;
}

/** Runs one cycle per linked guild while holding the leader lock. */
async function runAll(
    store: GuildSyncStore,
    deps: GuildSyncDeps,
    cycleDeps: CycleDeps,
    holder: string
): Promise<void> {
    const result = await store.withLeaderLock(holder, async () => {
        const links = await deps.listGuildLinks();
        if (links.length > MAX_LINKS_PER_RUN) {
            cycleDeps.logger.warn(
                `[guild-sync] ${links.length} guild links; syncing the first ${MAX_LINKS_PER_RUN}`
            );
        }
        for (const link of links.slice(0, MAX_LINKS_PER_RUN)) {
            await runCycle(link, cycleDeps);
        }
        await store.pruneSnapshots(
            new Date(cycleDeps.now().getTime() - SNAPSHOT_RETENTION_MS)
        );
    });
    if (!result.ran) {
        cycleDeps.logger.info(
            '[guild-sync] Another instance holds the leader lock'
        );
    }
}

/**
 * The guild-sync add-on. In this build it only plans: every cycle saves a
 * dry-run plan and logs its summary. Nothing is written to either server.
 */
export function createGuildSyncAddon(deps: GuildSyncDeps): Addon {
    let scheduler: SyncScheduler | null = null;
    let listener: ((...args: unknown[]) => void) | null = null;

    return {
        name: ADDON_NAME,
        async start(context: AddonContext) {
            const store = new PostgresGuildSyncStore(deps.sequelize);
            const cycleDeps: CycleDeps = {
                store,
                readers: {
                    discord: new DiscordGuildReader(deps.discordClient),
                    fluxer: new FluxerGuildReader(deps.fluxerClientRef),
                },
                processMode: () => context.mode.mode,
                logger: context.logger,
                now: () => new Date(),
                newId: randomUUID,
            };
            const holder = `${hostname()}:${process.pid}`;
            const run = async () => {
                await context.boundary.run(ADDON_NAME, 'cycle', () =>
                    runAll(store, deps, cycleDeps, holder)
                );
            };
            const active = new SyncScheduler(run, DEFAULT_SCHEDULE);
            listener = context.boundary.handler(ADDON_NAME, 'event', () =>
                active.notify()
            );
            for (const event of SOURCE_EVENTS)
                deps.discordClient.on(event, listener);
            scheduler = active;
            active.start();
        },
        async stop() {
            if (listener) {
                for (const event of SOURCE_EVENTS)
                    deps.discordClient.off(event, listener);
            }
            listener = null;
            await scheduler?.stop();
            scheduler = null;
        },
    };
}
