# Design: relay catch-up

Status: built in `src/relay-extras/catchUp/`.

## Problem

The relay copies messages when the gateway delivers them. Messages posted
while bifrost is down (a deploy, a restart, a crash) were never copied.

## What it does

Once per process start, after both clients are ready and the add-ons have
started, catch-up visits every channel link. For each direction it:

1. Finds where the gap starts (below).
2. Reads up to `BF_RELAY_CATCH_UP_MAX_MESSAGES` messages after that point
   from the source platform's REST API, in one request.
3. Leaves out what the live relay would leave out.
4. Relays the rest, oldest first, through the live relay itself.

It then logs one line per channel and direction with counts, and a summary.
Logs never carry message text.

## Where the gap starts

The `after` cursor is the newest of:

- The newest message of that side in `message_links` for the link, among
  links recorded **before this process started**. Links the live relay makes
  after startup do not count, so a live message that arrives early cannot
  hide the gap before it.
- The newest history copy of that side in the channel
  (`addon_history_messages`, only while the add-on tables exist).
- The time the channel link was made. Older messages belong to the history
  add-on, which copies up to the link time.
- Now minus `BF_RELAY_CATCH_UP_MAX_AGE_HOURS`.

## What is left out

- The bot's own messages, and messages from the link's own webhook (the
  live loop guards in `src/discord.ts` and `src/fluxer.ts`).
- Command strings (`BF_COMMAND_PREFIX`). Catch-up never runs a command.
- Join notices. The relay records no message link for them, so a second
  copy could not be detected.
- Any message with a copy already: one waiting in the retry queue
  (`queued_messages`), one in `message_links`, or a history copy. The queue
  is checked first, because the queue drain records the link before it
  deletes the entry.
- Channels the live relay does not copy (threads, forums). Their links are
  skipped with an info line; thread and forum post messages are caught up
  by guild-sync (see "Threads and forum posts").

Other bots and other webhooks are relayed, as the live relay does.

## Same send path

`src/discord.ts` and `src/fluxer.ts` bind their relay object to catch-up
(`SideRelay.bind`). Live messages and caught-up messages both call that
object's `relayMessage`. Formatting, mentions, replies, attachments,
fidelity, the retry queue and the `message_links` record are the same.

Catch-up starts after the add-ons, so message fidelity is installed for
caught-up copies too.

## Live messages during catch-up

A gate (`gate.ts`) is open from process start until catch-up ends.

- While it is open, each live message waits in a queue per channel and
  direction, then relays only if no copy exists yet.
- Catch-up holds that same queue for the whole of a channel.
- A live message that arrives while its channel catches up relays after it.
  If catch-up copied it already, it is not copied again.
- A live message that started before catch-up reached its channel finishes
  first. Its message link then stops catch-up from copying it.
- When the gate closes, live messages relay at once, as upstream does.

If the copy check fails for a live message, the message relays anyway: a
lost message is worse than a rare second copy. If the check fails during
catch-up, catch-up skips the message.

## Limits

- One list request per channel and direction, at most 100 messages.
- Each request is bounded to 30 seconds (the client libraries also time out
  their own requests).
- 1.05 seconds after each copy, which keeps a webhook under Fluxer's limit of
  60 messages a minute (`src/history/limits.ts`).
- The whole run stops starting new work after 10 minutes. Channels it did
  not reach are logged and stay missed.
- At most 1000 channel links.
- Catch-up waits up to 2 minutes for both clients to be ready. If one is not,
  catch-up is skipped and logged.
- While the Fluxer API has blocked this IP, the Fluxer side reads nothing,
  as the relay does. Copies to Fluxer go to the retry queue, as live ones do.
- A failed channel or message is logged; catch-up goes on with the next one.

## Threads and forum posts

Upstream's relay skips threads; guild-sync's thread relay copies them
(`src/guild-sync/threadRelay.ts`). Thread catch-up lives there too
(`src/guild-sync/threadCatchUp.ts`) and runs when guild-sync starts, with
the same settings. It needs add-ons and guild-sync on.

1. The thread relay starts listening and holds new live thread messages in
   memory (at most 1,000; past that they are relayed at once).
2. For each side, it lists the active threads of the linked guilds (at most
   500). A message posted in an archived thread unarchives it, so active
   threads are enough.
3. Per thread, the gap starts after the newest message of that side recorded
   in `addon_thread_messages` before start, or at the age limit. A thread
   whose last message is not newer is not read.
4. Messages pass the live skip rules (`threadEvents.ts`). It skips a post's
   starter (it has the post's ID), except an unpaired Fluxer one, which goes
   through so the relay mirrors the post; a message with a recorded copy;
   and a Discord reply the history import covered.
5. The rest go to the thread relay oldest first, one a second. The relay
   checks for a recorded copy before each send, so a message seen live and
   by catch-up is copied once. Replies of a post that is not synced yet park
   as live ones do.
6. Then the held live messages are relayed in arrival order.

## Settings

| Variable | Default | Range |
|---|---|---|
| `BF_RELAY_CATCH_UP` | on | true/false, 1/0, yes/no |
| `BF_RELAY_CATCH_UP_MAX_AGE_HOURS` | 24 | 1 to 168 |
| `BF_RELAY_CATCH_UP_MAX_MESSAGES` | 100 | 1 to 100 |

An invalid `BF_RELAY_CATCH_UP` stops startup. While catch-up is on, an
invalid limit stops startup too. Catch-up is part of the relay, not an
add-on: it runs whether add-ons are on or off, and in every add-on mode, as
the relay does.

## Known gaps

- A late copy carries the time it was relayed, not the original time.
- A full page means more messages were missed than the limit. Catch-up copies
  the oldest ones; the rest stay missed. The log says so.
- In a channel catch-up has not reached yet, a live message can be copied
  before the older messages of the gap.
- Messages read through REST may lack the author's server member data; a
  copy may then show the account name instead of the server nickname.
- Thread catch-up does not see a post deleted on one side while bifrost was
  down, nor edits and deletes of messages; neither does channel catch-up.
- Catch-up runs only at process start. A Fluxer client restart inside a
  running process does not trigger it. `message_links` does not record the
  direction of a copy, so after a one-sided outage the newest link can be a
  copy made after the missed messages; doing this safely needs a per-side
  record of the last event seen. After a short Discord drop, discord.js
  resumes the session and Discord replays the missed events (Discord
  Gateway docs, "Resuming").
