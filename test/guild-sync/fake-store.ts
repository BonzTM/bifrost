import type { MissingUpdate } from '../../src/guild-sync/guards';
import type { ReadResult } from '../../src/guild-sync/health';
import type { MapRow } from '../../src/guild-sync/ops';
import type { Plan } from '../../src/guild-sync/plan';
import type { GuildReader } from '../../src/guild-sync/readers/reader';
import type { GuildSnapshot } from '../../src/guild-sync/snapshot';
import type { GuildSyncStore, SyncSettings } from '../../src/guild-sync/store';

export const DEFAULT_SETTINGS: SyncSettings = {
    mode: 'dry-run',
    direction: 'discord-to-fluxer',
    killSwitch: false,
    shrinkPercent: 10,
    shrinkMinObjects: 5,
    confirmChecks: 3,
    confirmMinutes: 30,
    gracePeriodDays: 14,
    deleteBudgetPerCycle: 3,
    deleteBudgetPerDay: 10,
    writeCapPerCycle: 50,
};

/** An in-memory store that records every write. */
export class FakeStore implements GuildSyncStore {
    settings: SyncSettings = DEFAULT_SETTINGS;
    rows: MapRow[] = [];
    snapshots: { snapshot: GuildSnapshot; healthy: boolean }[] = [];
    missingWrites: MissingUpdate[][] = [];
    plans: Plan[] = [];
    lockHeld = false;

    async withLeaderLock<T>(_holder: string, fn: () => Promise<T>) {
        if (this.lockHeld) return { ran: false as const };
        this.lockHeld = true;
        try {
            return { ran: true as const, value: await fn() };
        } finally {
            this.lockHeld = false;
        }
    }

    async loadSettings() {
        return this.settings;
    }

    async loadObjectMap() {
        return this.rows;
    }

    async lastSnapshot(_link: string, side: string, healthyOnly: boolean) {
        const match = [...this.snapshots]
            .reverse()
            .find(
                (s) => s.snapshot.side === side && (s.healthy || !healthyOnly)
            );
        return match?.snapshot ?? null;
    }

    async saveSnapshot(
        _link: string,
        snapshot: GuildSnapshot,
        healthy: boolean
    ) {
        this.snapshots.push({ snapshot, healthy });
    }

    async saveMissing(updates: readonly MissingUpdate[]) {
        if (updates.length > 0) this.missingWrites.push([...updates]);
    }

    async savePlan(plan: Plan) {
        this.plans.push(plan);
    }

    async removalsSince() {
        return 0;
    }

    async pruneSnapshots() {}
}

/** A reader that returns fixed results and answers lookups from a set. */
export class FakeReader implements GuildReader {
    lookups = 0;

    constructor(
        public result: ReadResult,
        public gone: ReadonlySet<string> = new Set()
    ) {}

    async read() {
        return this.result;
    }

    async isGone(_guildId: string, _kind: string, id: string) {
        this.lookups += 1;
        return this.gone.has(id);
    }
}
