# Design: two-way thread settings

Status: built in `src/guild-sync/threadSettings.ts`.

## Scope

A bridge goes both ways. Messages already relay both ways. Thread and forum
post settings now sync both ways too.

- Two-way: a thread's `name`, `archived`, `locked`, `tags`, `pinned`,
  `rateLimitPerUser` and `autoArchiveDuration`.
- Never changed after creation: `private` and the parent channel.
- One-way, Discord to Fluxer: everything else. This includes channels,
  categories, roles, overwrites, emojis, stickers and server settings.

## Rules

Each cycle compares every setting of a mapped thread three ways:

- **Base**: the fields last written or agreed (`addon_object_map.appliedFields`).
  Without them, the last healthy Discord snapshot.
- **Source**: the Discord thread.
- **Destination**: the Fluxer copy.

| Discord | Fluxer | Result |
|---|---|---|
| changed | as base | Write the Discord value to Fluxer (`update`). |
| as base | changed | Write the Fluxer value to Discord (`write-back`). |
| changed | changed, to another value | Discord wins: write the Discord value to Fluxer, with a `conflict` finding. |
| changed | changed, to the same value | Record the value in the base. No write. |

Discord wins a tie only inside one sync window: both edits happened before
one cycle read them.

A setting with no base at all is reported as `drift` and never written.

## Limits

- A pin exists only on forum and media posts. A Fluxer pin on any other
  thread is reported as `drift`.
- Tags are written back only while every tag on both posts exists in both
  forums. Each writer skips a tag its forum lacks. Writing back a list that
  one side could not hold would strip that tag from the other side.
- Discord accepts an auto-archive of 60, 1440, 4320 or 10080 minutes. The
  Discord writer skips any other value, and the next cycle writes Discord's
  value to Fluxer.
- Discord refuses edits to an archived thread except its unarchive (error
  50083). The Discord writer reopens the thread in the first edit and
  archives it again last, as the Fluxer writer does.

## Modes and guards

A write-back is a plan op like any other:

- Dry run shows it in the plan and writes nothing.
- Only apply mode writes it. The kill switch and read-only mode stop it.
- The ownership guard keeps it only for a mapped thread pair.
- A refused write-back is a failed write, with the usual backoff.
- `sync enforce on` does not revert thread settings. Enforce still reverts
  Fluxer edits to the structure.

## Echo safety

The base records what bifröst wrote. Its own writes on either side, the
reopen and re-archive steps included, therefore never count as a person's
edit.

History import opens and closes Fluxer threads on its own:

- While a thread's import is not done, its write-backs wait. Discord edits
  still go to Fluxer. Finishing the import writes Discord's state to Fluxer
  and to the base.
- An edit of an imported copy in a closed thread puts the thread back in the
  Fluxer state it read before it opened the thread.

## Live trigger

A Fluxer `ThreadUpdate` of a mapped thread schedules a cycle, as a Discord
`ThreadUpdate` does. The scheduler debounces both. The periodic cycle catches
anything an event missed.
