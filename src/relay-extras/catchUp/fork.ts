import { addonDatabaseState } from '../../addons/state';
import sequelize from '../../db/sequelize';
import type { LinkService } from '../../services/LinkService';
import { COMMAND_PREFIX } from '../../utils/env';
import logger from '../../utils/logging/logger';
import type { Side } from '../types';
import { requireCatchUpConfig } from './config';
import { createRelayCatchUp, type RelayCatchUp } from './index';
import type { CatchUpLink } from './runner';
import { SqlCatchUpStore } from './store';

/**
 * The catch-up entry point for upstream's src/index.ts. It loads
 * upstream's env, database and logger, so it stays apart from './index',
 * which tests load without Bifröst's environment.
 */

/** Upstream lookups catch-up reads. */
type CatchUpLinkService = Pick<
    LinkService,
    | 'getAllGuildLinks'
    | 'getChannelLinksForDiscordGuild'
    | 'getMessageLinkByDiscordMessageId'
    | 'getMessageLinkByFluxerMessageId'
>;

/** Bound on the guild links one run reads. */
const MAX_GUILD_LINKS = 1_000;

/** Every channel link, guild by guild. */
export async function allChannelLinks(
    linkService: CatchUpLinkService
): Promise<CatchUpLink[]> {
    const guilds = (await linkService.getAllGuildLinks()).slice(
        0,
        MAX_GUILD_LINKS
    );
    const links: CatchUpLink[] = [];
    for (const guild of guilds) {
        const channels = await linkService.getChannelLinksForDiscordGuild(
            guild.discordGuildId
        );
        links.push(...channels);
    }
    return links;
}

/** True when upstream recorded a message link for the message. */
export function bridgedCheck(linkService: CatchUpLinkService) {
    return async (side: Side, messageId: string): Promise<boolean> => {
        const link =
            side === 'discord'
                ? await linkService.getMessageLinkByDiscordMessageId(messageId)
                : await linkService.getMessageLinkByFluxerMessageId(messageId);
        return link !== null && link !== undefined;
    };
}

/**
 * Reads BF_RELAY_CATCH_UP* and throws on a bad value. Call it before the
 * clients start: the process start time it records splits links bridged
 * before the downtime from those the live relay makes now.
 */
export function forkCatchUp(linkService: CatchUpLinkService): RelayCatchUp {
    const config = requireCatchUpConfig(process.env);
    if (!config.enabled) logger.info('[catch-up] Relay catch-up is off');
    return createRelayCatchUp({
        config,
        store: new SqlCatchUpStore(
            sequelize,
            () => addonDatabaseState() === 'ready'
        ),
        bridged: bridgedCheck(linkService),
        listLinks: () => allChannelLinks(linkService),
        commandPrefix: COMMAND_PREFIX,
        startedAt: new Date(),
        logger,
    });
}
