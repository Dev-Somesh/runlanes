/**
 * The source interface.
 *
 * runlanes knows nothing about any particular agent runner. A source
 * discovers runs on disk and normalises them into the shapes below; everything
 * else — the server, the timeline, the graph — works only against these.
 *
 * Adding support for a new runner means writing one file in this directory and
 * registering it in index.js. Nothing outside sources/ should ever reference a
 * vendor name or a vendor-specific path.
 *
 * @typedef {object} Source
 * @property {string} id            Short identifier, e.g. "claude-code".
 * @property {string} label         Human name shown in the UI.
 * @property {() => boolean} detect Is this runner present on this machine?
 * @property {(opts: {cwd: string}) => Session[]} sessions
 * @property {((opts: {cwd: string}) => DocumentCollection[])} [documents]
 *   Optional. Markdown a runner keeps alongside a project — plans, skills,
 *   agent definitions. Sources that have no such concept simply omit this.
 *
 * @typedef {object} DocumentCollection
 * @property {string} id
 * @property {string} label
 * @property {string} scope        "project" or "user".
 * @property {Document[]} items
 *
 * @typedef {object} Document
 * @property {string} id
 * @property {string} name
 * @property {string} path         Shown so the reader knows what they are reading.
 * @property {string|null} [rel]   Repo-relative path, when the file is in the project.
 * @property {string|null} updatedAt
 * @property {number} bytes
 * @property {string} markdown
 *
 * @typedef {object} Session
 * @property {string} id
 * @property {string} sourceId
 * @property {string} [sourceLabel]       Filled by the server from the source registry.
 * @property {string|null} startedAt      ISO 8601.
 * @property {string|null} lastActivityAt ISO 8601.
 * @property {Run[]} runs
 * @property {SessionTotals} totals
 *
 * @typedef {object} Run
 *   One agent invocation.
 * @property {string} id
 * @property {string} name            What it was asked to do.
 * @property {string|null} kind       Agent type, if the runner records one.
 * @property {string|null} model
 * @property {string|null} effort
 * @property {"running"|"finished"} status
 * @property {boolean} [usageRecorded]  False when the runner's transcripts carry
 *   no usage data at all. Such a run reports 0 tokens because the shape needs a
 *   number, but 0 means "unmeasured", not "free" — readers must not sum it or
 *   price it. Omitted means true.
 * @property {number} tokens          Consumed: input + output + cache creation.
 * @property {number} outputTokens
 * @property {number} [cacheWriteTokens]  Priced above input rate; already in `tokens`.
 * @property {number} [cacheReadTokens]   Priced far below input rate; NOT in `tokens`,
 *   because summing cache reads double-counts the prompt. Billed all the same,
 *   so cost uses it even though the token headline does not.
 * @property {number} toolCalls
 * @property {number} turns
 * @property {string|null} startedAt
 * @property {string|null} lastActivityAt
 * @property {number|null} durationMs
 * @property {string[]} reads         Repo-relative paths.
 * @property {string[]} writes        Repo-relative paths.
 * @property {FileEvent[]} [fileEvents]  The same contact, kept in the order the
 *   runner recorded it. `reads` and `writes` say a run touched a path; this says
 *   when, where the transcript was willing to say. Additive on purpose: the two
 *   arrays above are public surface, in `--json`, in the `./sources` export and
 *   in every snapshot already written.
 * @property {number|null} depth      Spawn depth, if known.
 *
 * @typedef {object} FileEvent
 * @property {string} path            Repo-relative.
 * @property {"read"|"write"} kind
 * @property {string|null} at         ISO timestamp, or null when the runner did
 *   not stamp the call. Null is the honest answer and not a zero: Cursor stamps
 *   its user turns rather than its tool calls, and Kiro times an execution
 *   rather than the actions inside it.
 *
 * @typedef {object} SessionTotals
 * @property {number} tokens
 * @property {number} outputTokens
 * @property {number} toolCalls
 * @property {number} contextNow      Size of the most recent prompt, if known.
 * @property {string|null} model
 */

/**
 * Tokens genuinely consumed by a turn.
 *
 * Cache reads are deliberately excluded: they re-report the entire prompt on
 * every turn, so summing them across a session counts the same context dozens
 * of times and produces a number several times larger than reality.
 */
export function consumedTokens(usage) {
  if (!usage || typeof usage !== "object") return 0;
  return (
    (usage.input_tokens || 0) +
    (usage.output_tokens || 0) +
    (usage.cache_creation_input_tokens || 0)
  );
}

/**
 * A run is considered finished when it has been quiet for this long.
 *
 * Transcripts carry no terminal marker, so completion is inferred from write
 * recency. This is an inference and the UI says so rather than presenting it
 * as fact.
 */
export const IDLE_MS = 90_000;

export function statusFromLastWrite(lastActivityAt, now = Date.now()) {
  if (!lastActivityAt) return "finished";
  return now - new Date(lastActivityAt).getTime() < IDLE_MS ? "running" : "finished";
}

/**
 * Puts a run's file contact in the order the transcript reported it.
 *
 * Adapters keep their own read and write sets, which are public surface and
 * were not worth reshaping for this. They push an event beside each one and
 * hand the pile here.
 *
 * @param {FileEvent[]} events
 * @returns {FileEvent[]}
 */
export function orderFileEvents(events) {
  const seen = new Set();
  return events
    .filter((e) => {
      if (!e || !e.path) return false;
      const k = `${e.kind}\u0000${e.path}\u0000${e.at || ""}`;
      return seen.has(k) ? false : (seen.add(k), true);
    })
    .map((e) => ({ path: e.path, kind: e.kind, at: e.at || null }))
    // Stamped events in order; unstamped keep the transcript's order behind
    // them rather than claiming a position on the clock.
    .sort((a, b) => (a.at && b.at ? a.at.localeCompare(b.at) : a.at ? -1 : b.at ? 1 : 0));
}
