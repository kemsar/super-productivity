/**
 * Grammar for the quick-add overlay's natural-language input (issue #19).
 *
 * Shipped as a single UMD-shaped file so all three consumers can load one
 * source without a build step:
 *   - overlay HTML (Electron renderer, no bundler)  → `<script src>`  → `window.SPQuickAddParser`
 *   - Electron main / preload (Node CJS)            → `require(...)` → `module.exports`
 *   - Angular (TS + `moduleResolution: bundler`)    → `import * as p` → CJS via esModuleInterop
 *
 * ES module `export` syntax would break the overlay path because Electron's
 * file:// origin treats every module URL as its own origin and blocks the
 * import chain on CORS. Plain `<script>` skips that check entirely, so the
 * cost is authoring in a slightly older idiom in exchange for zero
 * bundling / preload / interception plumbing.
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

/* eslint-disable no-var */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && typeof module.exports === 'object') {
    // Node/Electron main + Angular via bundler (esModuleInterop turns this
    // into a namespace import).
    module.exports = api;
  }
  if (typeof root !== 'undefined' && root !== null) {
    // Overlay HTML: <script src="…/quick-add-parser.js"></script> exposes
    // the parser as a single global. Prefix intentional — the overlay runs
    // in a context where a bare `parseQuickAddText` would collide with
    // future globals; namespacing is a five-character cost.
    root.SPQuickAddParser = api;
  }
})(
  typeof self !== 'undefined'
    ? self
    : typeof globalThis !== 'undefined'
      ? globalThis
      : null,
  function () {
    'use strict';

    // Priority aliases — key on left is the canonical form we hand to the
    // adapter (matches GitLab's common `priority::high` scoped-label
    // vocabulary). Values on the right are the alternate spellings a user
    // might type.
    var PRIORITY_ALIASES = {
      low: ['low', 'lo', 'l', 'p4'],
      medium: ['medium', 'med', 'm', 'p3', 'normal'],
      high: ['high', 'hi', 'h', 'p2'],
      urgent: ['urgent', 'u', 'p1', 'critical', 'crit'],
    };

    var WEEKDAY_INDEX = {
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

    // Values after `@`, `##`, `!`, `!!`, `~`, `>` run until whitespace or EOL.
    // Deliberately permissive so GitLab paths (`odin/odin-api`), scoped-label
    // milestones (`v2.0`), and hyphenated dates (`2026-07-24`) all fall
    // through as one token.
    var isValidTokenChar = function (c) {
      return c !== undefined && !/\s/.test(c);
    };

    // Splits the raw input into (line1, restOfLines). Line 1 carries the
    // title and tokens; line 2+ (if any) is the description. Trailing empty
    // lines are dropped; interior blank lines within the description are
    // preserved.
    var _splitLines = function (raw) {
      var nl = raw.indexOf('\n');
      if (nl === -1) {
        return { titleLine: raw, description: undefined };
      }
      var titleLine = raw.slice(0, nl);
      var rest = raw.slice(nl + 1).replace(/\s+$/, '');
      return { titleLine: titleLine, description: rest.length ? rest : undefined };
    };

    var _canonicalizePriority = function (raw) {
      var lower = raw.toLowerCase();
      var canonicals = Object.keys(PRIORITY_ALIASES);
      for (var i = 0; i < canonicals.length; i++) {
        if (PRIORITY_ALIASES[canonicals[i]].indexOf(lower) !== -1) {
          return canonicals[i];
        }
      }
      return null;
    };

    var _isValidDate = function (d, y, m, dd) {
      return d.getFullYear() === y && d.getMonth() === m - 1 && d.getDate() === dd;
    };

    var _formatIsoDate = function (d) {
      var pad = function (n) {
        return n < 10 ? '0' + n : '' + n;
      };
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    };

    /**
     * Resolves a `~<date>` token to ISO `YYYY-MM-DD`.
     *
     * Understood forms:
     *  - `today`, `tod`
     *  - `tomorrow`, `tom`, `tmrw`
     *  - Weekday names / prefixes (`mon`, `tue`, ...). Resolves to the NEXT
     *    occurrence — if today is Monday and the user types `~mon`, the
     *    result is 7 days out, not today. Matches Todoist and Fantastical.
     *  - `YYYY-MM-DD` (or `YYYY/MM/DD`)
     *  - `MM-DD` / `M-D` / `MM/DD` — this year (no year-roll)
     *
     * `now` is injected so callers (tests, deterministic runs) can pin it.
     */
    var resolveDateToken = function (raw, now) {
      if (now === undefined) now = new Date();
      var lower = String(raw || '')
        .trim()
        .toLowerCase();
      if (!lower) return null;

      if (lower === 'today' || lower === 'tod') {
        return _formatIsoDate(now);
      }
      if (lower === 'tomorrow' || lower === 'tom' || lower === 'tmrw') {
        var tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        return _formatIsoDate(tomorrow);
      }

      var weekdayTarget = WEEKDAY_INDEX[lower];
      if (weekdayTarget !== undefined) {
        var todayDow = now.getDay();
        var delta = (weekdayTarget - todayDow + 7) % 7 || 7;
        var next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + delta);
        return _formatIsoDate(next);
      }

      var isoMatch = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(lower);
      if (isoMatch) {
        var y = Number(isoMatch[1]);
        var m = Number(isoMatch[2]);
        var d = Number(isoMatch[3]);
        var parsed = new Date(y, m - 1, d);
        return _isValidDate(parsed, y, m, d) ? _formatIsoDate(parsed) : null;
      }

      var mdMatch = /^(\d{1,2})[-/](\d{1,2})$/.exec(lower);
      if (mdMatch) {
        var mm = Number(mdMatch[1]);
        var dd = Number(mdMatch[2]);
        var yy = now.getFullYear();
        var mdParsed = new Date(yy, mm - 1, dd);
        return _isValidDate(mdParsed, yy, mm, dd) ? _formatIsoDate(mdParsed) : null;
      }

      return null;
    };

    /**
     * Parses a single line of quick-add input plus optional multi-line
     * description that follows. See file-level JSDoc for the grammar.
     *
     * Returns a QuickAddParseResult object:
     *   {
     *     title: string,              // tokens stripped, whitespace collapsed
     *     rawTitle: string,           // original line-1
     *     description?: string,       // line-2+ (trimmed at tail)
     *     projectMarker?: string,     // raw `<value>` after `!`
     *     assignees: string[],        // deduped case-insensitive, order preserved
     *     milestone?: string,
     *     dueDate?: string,           // ISO YYYY-MM-DD (undefined if unparseable)
     *     dueDateRaw?: string,        // raw token content (always set when ~ present)
     *     priority?: string,          // low | medium | high | urgent
     *     priorityRaw?: string,
     *     status?: string,            // canonicalized (lowercased, spaces→hyphen)
     *     statusRaw?: string,
     *     unresolved: string[],       // tokens that failed to resolve
     *   }
     */
    var parseQuickAddText = function (raw, opts) {
      opts = opts || {};
      var now = opts.now || new Date();
      var split = _splitLines(raw == null ? '' : raw);
      var titleLine = split.titleLine;

      var result = {
        title: '',
        rawTitle: titleLine,
        description: split.description,
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

      var i = 0;
      var titleOut = '';
      var seenAssignees = Object.create(null);

      var readTokenValue = function (startIdx) {
        var end = startIdx;
        while (isValidTokenChar(titleLine[end])) {
          end++;
        }
        return { value: titleLine.slice(startIdx, end), nextIdx: end };
      };

      while (i < titleLine.length) {
        var ch = titleLine[i];
        var prevIsWhitespaceOrStart = i === 0 || /\s/.test(titleLine[i - 1]);

        if (!prevIsWhitespaceOrStart) {
          // A `!` or `@` in the middle of a word is not a token — pass it
          // through (e.g. "email me@example.com" or "wtf!").
          titleOut += ch;
          i++;
          continue;
        }

        // Order matters: `##` before `#` (no bare `#` token today, but the
        // double hash marker must not be split); `!!` before `!`.
        if (ch === '#' && titleLine[i + 1] === '#') {
          var msVal = readTokenValue(i + 2);
          if (msVal.value) {
            result.milestone = msVal.value;
            i = msVal.nextIdx;
            continue;
          }
        }
        if (ch === '!' && titleLine[i + 1] === '!') {
          var prVal = readTokenValue(i + 2);
          if (prVal.value) {
            result.priorityRaw = prVal.value;
            var canonical = _canonicalizePriority(prVal.value);
            if (canonical) {
              result.priority = canonical;
            } else {
              result.unresolved.push('!!' + prVal.value);
            }
            i = prVal.nextIdx;
            continue;
          }
        }
        if (ch === '!') {
          var pjVal = readTokenValue(i + 1);
          if (pjVal.value) {
            result.projectMarker = pjVal.value;
            i = pjVal.nextIdx;
            continue;
          }
        }
        if (ch === '@') {
          var asVal = readTokenValue(i + 1);
          if (asVal.value) {
            // Strip an optional leading `@` in case the user typed `@@name`
            // (autocomplete pastes tend to do this).
            var clean = asVal.value.replace(/^@+/, '');
            var key = clean.toLowerCase();
            if (clean && !seenAssignees[key]) {
              seenAssignees[key] = true;
              result.assignees.push(clean);
            }
            i = asVal.nextIdx;
            continue;
          }
        }
        if (ch === '~') {
          var dtVal = readTokenValue(i + 1);
          if (dtVal.value) {
            result.dueDateRaw = dtVal.value;
            var iso = resolveDateToken(dtVal.value, now);
            if (iso) {
              result.dueDate = iso;
            } else {
              result.unresolved.push('~' + dtVal.value);
            }
            i = dtVal.nextIdx;
            continue;
          }
        }
        if (ch === '>') {
          var stVal = readTokenValue(i + 1);
          if (stVal.value) {
            result.statusRaw = stVal.value;
            // Canonicalize whitespace-hostile forms so `>in-progress`,
            // `>in_progress`, `>InProgress` all resolve the same way. The
            // adapter has final say when mapping to work-item statuses.
            result.status = stVal.value.toLowerCase().replace(/[_\s]+/g, '-');
            i = stVal.nextIdx;
            continue;
          }
        }

        titleOut += ch;
        i++;
      }

      result.title = titleOut.replace(/\s+/g, ' ').trim();
      return result;
    };

    return {
      parseQuickAddText: parseQuickAddText,
      resolveDateToken: resolveDateToken,
      QUICK_ADD_GRAMMAR_VERSION: 1,
    };
  },
);
