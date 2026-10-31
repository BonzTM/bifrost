import { GatewayIntentBits } from 'discord.js';
import type { AddonConfig } from './config';

/**
 * Extra Discord gateway intents the enabled add-ons need.
 *
 * Guild Members is a privileged intent. Discord refuses the login if it is
 * requested but not enabled for the bot in the developer portal, which would
 * also take the relay down. It is requested only when identity is on.
 */
export function addonDiscordIntents(config: AddonConfig): GatewayIntentBits[] {
    const intents = new Set<GatewayIntentBits>();
    if (config.guildSync) intents.add(GatewayIntentBits.GuildExpressions);
    if (config.identity) {
        intents.add(GatewayIntentBits.GuildMembers);
        intents.add(GatewayIntentBits.DirectMessages);
    }
    return [...intents];
}
