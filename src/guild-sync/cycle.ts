import type { SyncDirection } from '../addons/db/schema';
import type { AddonLogger } from '../addons/isolation';
import type { AddonMode } from '../addons/config';
import { diff } from './diff';
import {
    applyMissing,
    checkDeleteBudget,
    enforceOwnership,
    orderAndCap,
    planRemovals,
    removalCandidates,
    trackMissing,
} from './guards';
import { checkShrink, checkSourceHealth } from './health';
import { IdMap } from './idmap';
import type { Finding, MapRow } from './ops';
import { sourceIdOf } from './ops';
import { EMPTY_BODY, summarizePlan, type Plan, type PlanBody } from './plan';
import type { GuildReader } from './readers/reader';
import type { GuildSnapshot } from './snapshot';
import { countObjects, stableJson } from './snapshot';
import type { GuildSyncStore, SyncSettings } from './store';

/** The upstream guild link a cycle syncs. */
export interface LinkedGuild {
    readonly id: string;
    readonly discordGuildId: string;
    readonly fluxerGuildId: string;
}

export interface CycleDeps {
    readonly store: GuildSyncStore;
    readonly readers: {
        readonly discord: GuildReader;
        readonly fluxer: GuildReader;
    };
    /** The process-wide add-on mode (guards 9 and 15). */
    readonly processMode: () => AddonMode;
    readonly logger: AddonLogger;
    readonly now: () => Date;
    readonly newId: () => string;
}

export type CycleOutcome =
    | { readonly status: 'skipped'; readonly reason: string }
    | { readonly status: 'planned'; readonly plan: Plan };

/** Direct lookups per cycle for guard 4. The rest wait for a later cycle. */
export const MAX_LOOKUPS_PER_CYCLE = 20;

const DAY_MS = 24 * 60 * 60_000;

/**
 * The stricter of the process mode and the link's settings. Apply is not
 * built yet, so it is planned as dry-run: no path here writes to a server.
 */
export function resolveMode(
    processMode: AddonMode,
    settings: SyncSettings
): { mode: 'read-only' | 'dry-run'; reason: string | null } {
    if (settings.killSwitch)
        return { mode: 'read-only', reason: 'kill switch is on' };
    if (processMode === 'read-only')
        return { mode: 'read-only', reason: 'add-ons are read-only' };
    if (settings.mode === 'read-only')
        return { mode: 'read-only', reason: 'link is read-only' };
    return { mode: 'dry-run', reason: null };
}

function sides(link: LinkedGuild, direction: SyncDirection) {
    const discordToFluxer = direction === 'discord-to-fluxer';
    return {
        source: discordToFluxer ? ('discord' as const) : ('fluxer' as const),
        dest: discordToFluxer ? ('fluxer' as const) : ('discord' as const),
        sourceGuildId: discordToFluxer
            ? link.discordGuildId
            : link.fluxerGuildId,
        destGuildId: discordToFluxer ? link.fluxerGuildId : link.discordGuildId,
    };
}

type GateOutcome =
    | {
          ok: true;
          source: GuildSnapshot;
          destination: GuildSnapshot;
          lastHealthy: GuildSnapshot | null;
      }
    | { ok: false; reason: string; needsApproval: boolean };

/** Reads both sides and runs guards 2 and 3. Nothing is diffed on failure. */
async function readAndGate(
    link: LinkedGuild,
    settings: SyncSettings,
    deps: CycleDeps,
    takenAt: Date
): Promise<GateOutcome> {
    const s = sides(link, settings.direction);
    const gate = checkSourceHealth(
        await deps.readers[s.source].read(s.sourceGuildId)
    );
    if (!gate.ok)
        return { ok: false, reason: gate.reason, needsApproval: false };
    const lastHealthy = await deps.store.lastSnapshot(link.id, s.source, true);
    const shrink = checkShrink(
        gate.snapshot,
        lastHealthy ? countObjects(lastHealthy) : null,
        settings
    );
    if (!shrink.ok) {
        await deps.store.saveSnapshot(link.id, gate.snapshot, false, takenAt);
        // Guard 3 needs a person. The last healthy snapshot stays as it was,
        // so later cycles abort the same way until the source recovers.
        // Accepting a real shrink needs the approval flow (not built yet).
        return {
            ok: false,
            reason: `shrink check: ${shrink.reason}`,
            needsApproval: true,
        };
    }
    const destRead = await deps.readers[s.dest].read(s.destGuildId);
    if (!destRead.ok) {
        return {
            ok: false,
            reason: `destination ${destRead.reason}: ${destRead.detail}`,
            needsApproval: false,
        };
    }
    return {
        ok: true,
        source: gate.snapshot,
        destination: destRead.snapshot,
        lastHealthy,
    };
}

/** Saves a snapshot unless it matches the last one saved for that side. */
async function saveIfChanged(
    store: GuildSyncStore,
    linkId: string,
    snapshot: GuildSnapshot,
    takenAt: Date
): Promise<void> {
    const last = await store.lastSnapshot(linkId, snapshot.side, true);
    if (last && stableJson(last) === stableJson(snapshot)) return;
    await store.saveSnapshot(linkId, snapshot, true, takenAt);
}

/** Runs guard 4's direct lookups for up to MAX_LOOKUPS_PER_CYCLE rows. */
async function confirmGone(
    candidates: readonly MapRow[],
    reader: GuildReader,
    guildId: string,
    direction: SyncDirection
): Promise<Set<string>> {
    const gone = new Set<string>();
    for (const row of candidates.slice(0, MAX_LOOKUPS_PER_CYCLE)) {
        const sourceId = sourceIdOf(row, direction);
        if (!sourceId || row.kind === 'overwrite') continue;
        if ((await reader.isGone(guildId, row.kind, sourceId)) === true)
            gone.add(row.id);
    }
    return gone;
}

function protectedIds(destination: GuildSnapshot): Set<string> {
    return new Set([
        destination.guildId,
        destination.everyoneRoleId,
        ...(destination.bot?.roleIds ?? []),
    ]);
}

/** Diff plus guards 1, 4 to 7 and 14, in that order. */
async function buildBody(
    link: LinkedGuild,
    settings: SyncSettings,
    gated: Extract<GateOutcome, { ok: true }>,
    deps: CycleDeps,
    now: Date
): Promise<PlanBody> {
    const { direction } = settings;
    const { source, destination } = gated;
    const loaded = await deps.store.loadObjectMap(link.id);
    const missing = trackMissing(loaded, source, direction, now);
    await deps.store.saveMissing(missing, now);
    const rows = applyMissing(loaded, missing);

    const found = diff({
        source,
        destination,
        previousSource: gated.lastHealthy,
        rows,
        direction,
    });
    const candidates = removalCandidates(rows, settings, now);
    const s = sides(link, direction);
    const gone = await confirmGone(
        candidates,
        deps.readers[s.source],
        s.sourceGuildId,
        direction
    );
    const removals = planRemovals(
        candidates.slice(0, MAX_LOOKUPS_PER_CYCLE),
        gone,
        direction,
        settings,
        now
    );

    const map = IdMap.from(rows, direction, source, destination);
    const owned = enforceOwnership(
        [...found.ops, ...removals.ops],
        map,
        protectedIds(destination)
    );
    const removalsToday = await deps.store.removalsSince(
        link.id,
        new Date(now.getTime() - DAY_MS)
    );
    const budget = checkDeleteBudget(owned.kept, settings, removalsToday);
    const capped = orderAndCap(owned.kept, settings.writeCapPerCycle);
    const findings: Finding[] = [
        ...found.findings,
        ...removals.findings,
        ...owned.dropped,
    ];
    return {
        ops: capped.now,
        deferred: capped.deferred,
        findings,
        needsApproval: budget.needsApproval,
        approvalReason: budget.needsApproval ? budget.reason : null,
    };
}

function newPlan(
    deps: CycleDeps,
    link: LinkedGuild,
    direction: SyncDirection,
    body: PlanBody,
    abortReason: string | null
): Plan {
    return {
        id: deps.newId(),
        guildLinkId: link.id,
        direction,
        status: abortReason ? 'aborted' : 'dry-run',
        body,
        abortReason,
    };
}

/**
 * One reconcile cycle for one guild link (design: Cycle steps 2 to 7).
 * It always ends at the saved plan: in dry-run nothing is applied, and no
 * apply path exists yet.
 */
export async function runCycle(
    link: LinkedGuild,
    deps: CycleDeps
): Promise<CycleOutcome> {
    const settings = await deps.store.loadSettings(link.id);
    const mode = resolveMode(deps.processMode(), settings);
    if (mode.mode === 'read-only')
        return { status: 'skipped', reason: mode.reason ?? 'read-only' };

    const now = deps.now();
    const gated = await readAndGate(link, settings, deps, now);
    let plan: Plan;
    if (!gated.ok) {
        const body: PlanBody = gated.needsApproval
            ? {
                  ...EMPTY_BODY,
                  needsApproval: true,
                  approvalReason: gated.reason,
              }
            : EMPTY_BODY;
        plan = newPlan(deps, link, settings.direction, body, gated.reason);
        deps.logger.warn(
            `[guild-sync] Cycle aborted for link ${link.id}: ${gated.reason}`
        );
    } else {
        await saveIfChanged(deps.store, link.id, gated.source, now);
        await saveIfChanged(deps.store, link.id, gated.destination, now);
        const body = await buildBody(link, settings, gated, deps, now);
        plan = newPlan(deps, link, settings.direction, body, null);
    }
    await deps.store.savePlan(plan, now);
    deps.logger.info(`[guild-sync] ${summarizePlan(plan)}`);
    return { status: 'planned', plan };
}
