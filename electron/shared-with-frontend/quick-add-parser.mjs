/**
 * Grammar for the quick-add overlay's natural-language input (issue #19).
 *
 * Authored as a plain ES module so BOTH the overlay HTML (loaded from
 * disk in an Electron renderer, no bundler in the loop) AND the Angular
 * codebase can import the same source. `moduleResolution: 'bundler'` in
 * the SP tsconfig lets TypeScript pick up the `.mjs` extension via a
 * `.mjs` relative import; the overlay loads it with
 * `<script type="module" src="./shared-with-frontend/quick-add-parser.mjs">`.
 *
 * Tokens (all optional, any order, any position in the title line):
 *   !<project>       — target project (existing #26 semantics)
 *   @<username>      — assignee, repeatable
 *   ##<milestone>    — milestone (create-if-missing on GitLab side)
 *   ~<date>          — due date. today | tom(orrow) | mon..sun | YYYY-MM-DD | MM-DD
 *   !!<priority>     — priority. low | med(ium) | high | urgent
 *   ><status>        — work-item status. Passed through verbatim to the adapter.
 *
 * Line 2+ (input textarea with newlines) is the description.
 *
 * The parser is UI-optimistic on unknowns: an unrecognized date, priority,
 * or status is kept as a raw `unresolved` string on the result so the UI
 * can surface a warning chip instead of silently discarding the token.
 * That decision is deliberate — the overlay must never eat user intent.
 */

/** @typedef {'low' | 'medium' | 'high' | 'urgent'} QuickAddPriority */

/**
 * @typedef {Object} QuickAddParseResult
 * @property {string} title                 — title with all tokens stripped, whitespace-collapsed
 * @property {string} rawTitle              — original line-1 input, tokens included
 * @property {string} [description]         — line-2+ verbatim (trimmed), undefined if empty
 * @property {string} [projectMarker]       — the raw `<value>` after `!`
 * @property {string[]} assignees           — usernames after `@` in encounter order, deduped
 * @property {string} [milestone]           — raw `<value>` after `##`
 * @property {string} [dueDate]             — ISO YYYY-MM-DD, or undefined if the date token was unparseable
 * @property {string} [dueDateRaw]          — the raw token content (`fri`, `07-24`, ...) always populated when the ~token was present
 * @property {QuickAddPriority} [priority]
 * @property {string} [priorityRaw]
 * @property {string} [status]              — canonicalized (lowercased, spaces-to-hyphen) if the raw form was ambiguous; else raw
 * @property {string} [statusRaw]
 * @property {string[]} unresolved          — tokens whose value couldn't be interpreted (invalid date, unknown priority, etc.)
 */

// Priority aliases — key on left is the canonical form we hand to the adapter
// (matches GitLab's common `priority::high` scoped-label vocabulary). Values
// on the right are the alternate spellings a user might type.
const PRIORITY_ALIASES = {
  low: ['low', 'lo', 'l', 'p4'],
  medium: ['medium', 'med', 'm', 'p3', 'normal'],
  high: ['high', 'hi', 'h', 'p2'],
  urgent: ['urgent', 'u', 'p1', 'critical', 'crit'],
};

const WEEKDAY_INDEX = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const isValidTokenChar = (c) => {
  // Values after `@`, `##`, `!`, `!!`, `~`, `>` run until whitespace or EOL.
  // Deliberately permissive so GitLab paths (`odin/odin-api`), scoped-label
  // milestones (`v2.0`), and hyphenated dates (`2026-07-24`) all fall through
  // as one token.
  return c !== undefined && !/\s/.test(c);
};

/**
 * Splits the raw input into (line1, restOfLines). Line 1 carries the title
 * and tokens; line 2+ (if any) is the description. Trailing empty lines are
 * dropped; interior blank lines within the description are preserved.
 * @param {string} raw
 * @returns {{ titleLine: string, description: string | undefined }}
 */
const _splitLines = (raw) => {
  const nl = raw.indexOf('\n');
  if (nl === -1) {
    return { titleLine: raw, description: undefined };
  }
  const titleLine = raw.slice(0, nl);
  const rest = raw.slice(nl + 1).replace(/\s+$/, '');
  return { titleLine, description: rest.length ? rest : undefined };
};

/**
 * Normalizes a raw priority token to the canonical form the adapter uses.
 * @returns {QuickAddPriority | null}
 */
const _canonicalizePriority = (raw) => {
  const lower = raw.toLowerCase();
  for (const canonical of Object.keys(PRIORITY_ALIASES)) {
    if (PRIORITY_ALIASES[canonical].includes(lower)) {
      return /** @type {QuickAddPriority} */ (canonical);
    }
  }
  return null;
};

/**
 * Resolves a `~<date>` token to ISO `YYYY-MM-DD`.
 *
 * Understood forms:
 *  - `today`, `tod`
 *  - `tomorrow`, `tom`, `tmrw`
 *  - Weekday names / prefixes (`mon`, `tue`, `wed`, `thu`, `fri`, `sat`, `sun`,
 *    plus common longer spellings). Resolves to the NEXT occurrence — if today
 *    is Monday and the user types `~mon`, the result is 7 days out, not today.
 *  - `YYYY-MM-DD` (or `YYYY/MM/DD`)
 *  - `MM-DD` / `M-D` / `MM/DD` — this year
 *
 * `now` is injected so callers (tests, deterministic runs) can pin it. The
 * default is `new Date()` at call time.
 *
 * @param {string} raw
 * @param {Date} [now]
 * @returns {string | null}
 */
export const resolveDateToken = (raw, now = new Date()) => {
  const lower = raw.trim().toLowerCase();
  if (!lower) return null;

  if (lower === 'today' || lower === 'tod') {
    return _formatIsoDate(now);
  }
  if (lower === 'tomorrow' || lower === 'tom' || lower === 'tmrw') {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return _formatIsoDate(d);
  }

  const weekdayTarget = WEEKDAY_INDEX[lower];
  if (weekdayTarget !== undefined) {
    // Resolve to NEXT occurrence — matching `~mon` to today when today IS
    // Monday is almost always a mistake ("mon" typed on Monday means "next
    // Monday", not today; the user would have typed "today"). This mirrors
    // Todoist and Fantastical.
    const todayDow = now.getDay();
    const delta = (weekdayTarget - todayDow + 7) % 7 || 7;
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + delta);
    return _formatIsoDate(d);
  }

  // Absolute YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(lower);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    const parsed = new Date(Number(y), Number(m) - 1, Number(d));
    if (_isValidDate(parsed, Number(y), Number(m), Number(d))) {
      return _formatIsoDate(parsed);
    }
    return null;
  }

  // MM-DD (this year). We accept 07-24, 7/24, 7-4.
  const mdMatch = /^(\d{1,2})[-/](\d{1,2})$/.exec(lower);
  if (mdMatch) {
    const [, m, d] = mdMatch;
    const y = now.getFullYear();
    const parsed = new Date(y, Number(m) - 1, Number(d));
    if (_isValidDate(parsed, y, Number(m), Number(d))) {
      return _formatIsoDate(parsed);
    }
    return null;
  }

  return null;
};

const _isValidDate = (d, y, m, dd) =>
  d.getFullYear() === y && d.getMonth() === m - 1 && d.getDate() === dd;

const _formatIsoDate = (d) => {
  const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * Parses a single line of quick-add input plus optional multi-line
 * description that follows. See file-level JSDoc for the grammar.
 *
 * @param {string} raw     The whole overlay input (`title line\n<description...>`)
 * @param {Object} [opts]
 * @param {Date} [opts.now]  Injected clock for deterministic date resolution.
 * @returns {QuickAddParseResult}
 */
export const parseQuickAddText = (raw, opts = {}) => {
  const now = opts.now ?? new Date();
  const { titleLine, description } = _splitLines(raw ?? '');

  /** @type {QuickAddParseResult} */
  const result = {
    title: '',
    rawTitle: titleLine,
    description,
    projectMarker: undefined,
    assignees: [],
    milestone: undefined,
    dueDate: undefined,
    dueDateRaw: undefined,
    priority: undefined,
    priorityRaw: undefined,
    status: undefined,
    statusRaw: undefined,
    unresolved: [],
  };

  // Walk the title character-by-character rather than regex-slice everything
  // in parallel — the tokens can appear in any order and a single-pass walker
  // makes it obvious how the "consume until whitespace" behavior applies to
  // each marker. `titleOut` accumulates non-token text; we collapse whitespace
  // at the end.
  let i = 0;
  let titleOut = '';
  const seenAssignees = new Set();

  const readTokenValue = (startIdx) => {
    let end = startIdx;
    while (isValidTokenChar(titleLine[end])) {
      end++;
    }
    return { value: titleLine.slice(startIdx, end), nextIdx: end };
  };

  while (i < titleLine.length) {
    const ch = titleLine[i];
    const prevIsWhitespaceOrStart = i === 0 || /\s/.test(titleLine[i - 1]);

    if (!prevIsWhitespaceOrStart) {
      // A `!` or `@` in the middle of a word is not a token — pass it through
      // (e.g. "email me@example.com" or "wtf!").
      titleOut += ch;
      i++;
      continue;
    }

    // Order matters: `##` before `#` (no bare `#` token today, but the double
    // hash marker must not be split), and `!!` before `!`. Same for `~`, `@`, `>`.
    if (ch === '#' && titleLine[i + 1] === '#') {
      const { value, nextIdx } = readTokenValue(i + 2);
      if (value) {
        result.milestone = value;
        i = nextIdx;
        continue;
      }
    }
    if (ch === '!' && titleLine[i + 1] === '!') {
      const { value, nextIdx } = readTokenValue(i + 2);
      if (value) {
        result.priorityRaw = value;
        const canonical = _canonicalizePriority(value);
        if (canonical) {
          result.priority = canonical;
        } else {
          result.unresolved.push(`!!${value}`);
        }
        i = nextIdx;
        continue;
      }
    }
    if (ch === '!') {
      const { value, nextIdx } = readTokenValue(i + 1);
      if (value) {
        result.projectMarker = value;
        i = nextIdx;
        continue;
      }
    }
    if (ch === '@') {
      const { value, nextIdx } = readTokenValue(i + 1);
      if (value) {
        // Strip an optional leading `@` in case the user typed `@@name`
        // (autocomplete pastes tend to do this).
        const clean = value.replace(/^@+/, '');
        const key = clean.toLowerCase();
        if (clean && !seenAssignees.has(key)) {
          seenAssignees.add(key);
          result.assignees.push(clean);
        }
        i = nextIdx;
        continue;
      }
    }
    if (ch === '~') {
      const { value, nextIdx } = readTokenValue(i + 1);
      if (value) {
        result.dueDateRaw = value;
        const iso = resolveDateToken(value, now);
        if (iso) {
          result.dueDate = iso;
        } else {
          result.unresolved.push(`~${value}`);
        }
        i = nextIdx;
        continue;
      }
    }
    if (ch === '>') {
      const { value, nextIdx } = readTokenValue(i + 1);
      if (value) {
        result.statusRaw = value;
        // Canonicalize whitespace-hostile forms so `>in-progress` and
        // `>in_progress` and `>InProgress` all resolve the same way. The
        // adapter still has final say when mapping to work-item statuses.
        result.status = value.toLowerCase().replace(/[_\s]+/g, '-');
        i = nextIdx;
        continue;
      }
    }

    titleOut += ch;
    i++;
  }

  result.title = titleOut.replace(/\s+/g, ' ').trim();
  return result;
};

/**
 * Version stamp — bumped whenever the grammar changes in a way callers must
 * be aware of. Currently unused, present so callers that stash a parsed
 * result on disk have a versioning hook when we start doing that.
 */
export const QUICK_ADD_GRAMMAR_VERSION = 1;
