import type { ChannelLinker } from '../guild-sync/links';
import { closedThreadCode } from './errors';
import { clipContent, contentHash, defuseMentions } from './format';
import { MAX_CONTENT_LENGTH } from './limits';
import type { HistoryStore } from './store';
import type {
    HistoryJob,
    HistoryPorts,
    ImportedMessage,
    SendTarget,
    ThreadFlags,
} from './types';

const EDITED_NOTE = '\n*Edited by its author*';

const OPEN: ThreadFlags = { archived: false, locked: false };

/**
 * The text an edit sets: cut to Fluxer's limit, with @everyone and @here
 * defused. The last line, such as the date note or the edit marker, is
 * kept.
 */
export function copyText(content: string): string {
    return clipContent(defuseMentions(content), MAX_CONTENT_LENGTH);
}

/**
 * Runs an edit. Returns null when it went through, or the code when
 * Fluxer refused it for a closed thread; any other error is thrown.
 */
async function refusedAsClosed(
    edit: () => Promise<void>
): Promise<string | null> {
    try {
        await edit();
        return null;
    } catch (error) {
        const code = closedThreadCode(error);
        if (code === null) throw error;
        return code;
    }
}

/**
 * What reopening a closed Fluxer thread for an edit needs. Fluxer refuses
 * webhook edits in an archived or locked thread (fluxer_api
 * ThreadMessageActivity assertWebhookCanEdit); deletes have no such check
 * (MessageDeleteService deleteWebhookMessage).
 */
export interface EditorThreads {
    /** The Fluxer thread's state now (HistoryPorts.fluxerThreadState). */
    fluxerState(
        guildLinkId: string,
        fluxerThreadId: string
    ): Promise<ThreadFlags>;
    /** Sets a Fluxer thread's archived and locked flags. */
    setState(
        guildLinkId: string,
        fluxerThreadId: string,
        state: ThreadFlags
    ): Promise<void>;
}

/**
 * Edits and deletes imported copies for their authors. Neither platform can
 * change a message's author, but the copy was sent by our webhook, so the
 * bot can change it on the author's behalf once their accounts are linked.
 */
export class HistoryEditor {
    /**
     * Without `threads`, an edit in a closed thread fails as Fluxer
     * refuses it.
     */
    constructor(
        private readonly store: HistoryStore,
        private readonly links: ChannelLinker,
        private readonly ports: Pick<HistoryPorts, 'editCopy' | 'deleteCopy'>,
        private readonly threads?: EditorThreads
    ) {}

    /** The imported copy, when `discordUserId` wrote the original. */
    async ownCopy(
        fluxerMessageId: string,
        discordUserId: string
    ): Promise<ImportedMessage | null> {
        const copy = await this.store.importedByFluxerId(fluxerMessageId);
        return copy && copy.discordAuthorId === discordUserId ? copy : null;
    }

    private async jobOf(copy: ImportedMessage): Promise<HistoryJob> {
        const job = await this.store.getJob(copy.jobId);
        if (!job) throw new Error('the import job is gone');
        return job;
    }

    /** The webhook that sent the copy: the import webhook or the bridge's. */
    private async target(
        copy: ImportedMessage,
        job: HistoryJob
    ): Promise<SendTarget> {
        const threadId = copy.inThread ? copy.fluxerTargetId : null;
        if (job.importWebhook?.id === copy.webhookId) {
            return { webhook: job.importWebhook, threadId };
        }
        const channel =
            job.kind === 'thread' ? job.parentDiscordId : job.discordId;
        const bridge = await this.links.byDiscordChannel(channel ?? '');
        if (!bridge || bridge.fluxerWebhook.id !== copy.webhookId) {
            throw new Error('the webhook that sent this copy is gone');
        }
        return { webhook: bridge.fluxerWebhook, threadId };
    }

    /**
     * Sets the author's new text, marked as edited. The copy no longer
     * shows its Discord source, so its mentions are cleared: a fix-up
     * (fixup.ts) must not render the source over the author's text.
     */
    async edit(copy: ImportedMessage, text: string): Promise<void> {
        await this.replace(copy, `${text}${EDITED_NOTE}`);
        await this.store.recordMentions(copy.discordMessageId, []);
    }

    /**
     * Sets the copy's text (copyText) and records its new content hash,
     * which fix-ups compare a fresh rendering with.
     */
    async replace(copy: ImportedMessage, content: string): Promise<void> {
        const job = await this.jobOf(copy);
        const target = await this.target(copy, job);
        const text = copyText(content);
        await this.whileEditable(copy, job, () =>
            this.ports.editCopy(target, copy.fluxerMessageId ?? '', text)
        );
        await this.store.setContentHash(
            copy.discordMessageId,
            contentHash(text)
        );
    }

    async remove(copy: ImportedMessage): Promise<void> {
        const job = await this.jobOf(copy);
        await this.ports.deleteCopy(
            await this.target(copy, job),
            copy.fluxerMessageId ?? ''
        );
        await this.store.dropMessage(copy.discordMessageId);
    }

    /**
     * Runs an edit. When Fluxer refuses it because the copy's thread is
     * archived or locked, the thread is opened for the edit alone and
     * closed again as it was, even when the second try fails. "As it was"
     * is the Fluxer thread's own state, read before it is opened: thread
     * settings sync both ways, so any other state left behind would be
     * written back to Discord as a Fluxer edit (guild-sync threadSettings.ts).
     */
    private async whileEditable(
        copy: ImportedMessage,
        job: HistoryJob,
        edit: () => Promise<void>
    ): Promise<void> {
        const threads = this.threads;
        if (!copy.inThread || !threads) return edit();
        const refused = await refusedAsClosed(edit);
        if (refused === null) return;
        const threadId = copy.fluxerTargetId;
        const before = await threads.fluxerState(job.guildLinkId, threadId);
        await threads.setState(job.guildLinkId, threadId, OPEN);
        try {
            await edit();
        } finally {
            await threads.setState(job.guildLinkId, threadId, before);
        }
    }
}
