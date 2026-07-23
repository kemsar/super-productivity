// The parser is authored as a UMD-shaped `.js` (see file header for why —
// the overlay HTML has to load it as a plain `<script src>` and file:// CORS
// blocks `type="module"`). TypeScript resolves the extensionless import to
// the plain-JS file and `esModuleInterop` turns the CJS export into a
// namespace, so a destructured import here is fine.
import {
  parseQuickAddText,
  resolveDateToken,
} from '../../../electron/shared-with-frontend/quick-add-parser';

// Fixed reference date across the suite so weekday-name resolution and
// today/tomorrow are deterministic. 2026-07-15 is a Wednesday.
const NOW = new Date(2026, 6, 15);

describe('parseQuickAddText', () => {
  describe('title + description split', () => {
    it('treats a single line as title, no description', () => {
      const r = parseQuickAddText('Fix login bug', { now: NOW });
      expect(r.title).toBe('Fix login bug');
      expect(r.description).toBeUndefined();
    });

    it('lifts line 2+ into description verbatim, trimmed at the tail', () => {
      const r = parseQuickAddText(
        'Fix login bug\nRepro on Safari 17\nwith no cookie\n\n',
        {
          now: NOW,
        },
      );
      expect(r.title).toBe('Fix login bug');
      expect(r.description).toBe('Repro on Safari 17\nwith no cookie');
    });

    it('a title with a trailing newline and no description body is undefined description', () => {
      const r = parseQuickAddText('Fix login bug\n', { now: NOW });
      expect(r.description).toBeUndefined();
    });
  });

  describe('project marker (existing #26 semantics)', () => {
    it('extracts !<project> and strips it from the title', () => {
      const r = parseQuickAddText('Fix login bug !EIP', { now: NOW });
      expect(r.projectMarker).toBe('EIP');
      expect(r.title).toBe('Fix login bug');
    });

    it('accepts a GitLab-style path with slashes and dots as one token', () => {
      const r = parseQuickAddText('Wire !odin/odin-api thing', { now: NOW });
      expect(r.projectMarker).toBe('odin/odin-api');
      expect(r.title).toBe('Wire thing');
    });

    it('a bare ! (no value) is not a token — pass through verbatim', () => {
      const r = parseQuickAddText('WTF ! why', { now: NOW });
      expect(r.projectMarker).toBeUndefined();
      expect(r.title).toBe('WTF ! why');
    });

    it("a `!` mid-word (email-style, no leading whitespace) doesn't consume", () => {
      const r = parseQuickAddText('Ship!it now', { now: NOW });
      expect(r.projectMarker).toBeUndefined();
      expect(r.title).toBe('Ship!it now');
    });
  });

  describe('@assignee', () => {
    it('captures a single @name and dedupes repeats', () => {
      const r = parseQuickAddText('Fix @kevin @kevin @sarah bug', { now: NOW });
      expect(r.assignees).toEqual(['kevin', 'sarah']);
      expect(r.title).toBe('Fix bug');
    });

    it('is case-insensitive for dedupe but preserves the first form seen', () => {
      const r = parseQuickAddText('Ping @Kevin @kevin @KEVIN', { now: NOW });
      expect(r.assignees).toEqual(['Kevin']);
    });

    it("a `@` mid-word (email address in the description) doesn't consume", () => {
      const r = parseQuickAddText('Contact bob@example.com about', { now: NOW });
      expect(r.assignees).toEqual([]);
      expect(r.title).toBe('Contact bob@example.com about');
    });
  });

  describe('##milestone', () => {
    it('captures a single milestone token', () => {
      const r = parseQuickAddText('Ship ##v2.0 today', { now: NOW });
      expect(r.milestone).toBe('v2.0');
      expect(r.title).toBe('Ship today');
    });

    it("later ##token wins — we don't merge or reject", () => {
      // Ambiguous input shouldn't reject the task; take the last write. Matches
      // how Todoist handles duplicate labels — quiet + predictable.
      const r = parseQuickAddText('##first ##second bug', { now: NOW });
      expect(r.milestone).toBe('second');
    });
  });

  describe('#label', () => {
    it('captures a single #label and strips it from the title', () => {
      const r = parseQuickAddText('Fix #bug now', { now: NOW });
      expect(r.labels).toEqual(['bug']);
      expect(r.title).toBe('Fix now');
    });

    it('captures multiple labels, deduped case-insensitively, order preserved', () => {
      const r = parseQuickAddText('Fix #Bug #bug #frontend thing', { now: NOW });
      expect(r.labels).toEqual(['Bug', 'frontend']);
      expect(r.title).toBe('Fix thing');
    });

    it('keeps a hyphenated multi-word label as one token', () => {
      const r = parseQuickAddText('Do #needs-review please', { now: NOW });
      expect(r.labels).toEqual(['needs-review']);
      expect(r.title).toBe('Do please');
    });

    it('does not treat ## (milestone) as a #label', () => {
      const r = parseQuickAddText('Ship ##v2.0 with #bug fix', { now: NOW });
      expect(r.milestone).toBe('v2.0');
      expect(r.labels).toEqual(['bug']);
      expect(r.title).toBe('Ship with fix');
    });

    it('a bare # (no value) is not a token — pass through verbatim', () => {
      const r = parseQuickAddText('Note # 3 here', { now: NOW });
      expect(r.labels).toEqual([]);
      expect(r.title).toBe('Note # 3 here');
    });

    it("a `#` mid-word (e.g. an issue ref) doesn't consume", () => {
      const r = parseQuickAddText('See issue#42 later', { now: NOW });
      expect(r.labels).toEqual([]);
      expect(r.title).toBe('See issue#42 later');
    });
  });

  describe('~date', () => {
    it('resolves ~today', () => {
      const r = parseQuickAddText('Do it ~today', { now: NOW });
      expect(r.dueDate).toBe('2026-07-15');
      expect(r.dueDateRaw).toBe('today');
    });

    it('resolves ~tomorrow / ~tom / ~tmrw all to the same date', () => {
      for (const token of ['tomorrow', 'tom', 'tmrw']) {
        const r = parseQuickAddText(`Do it ~${token}`, { now: NOW });
        expect(r.dueDate).toBe('2026-07-16');
      }
    });

    it('resolves weekday names to the NEXT occurrence (not today, even if today matches)', () => {
      // NOW is Wednesday 2026-07-15; ~wed should resolve to next Wed (7-22).
      const r = parseQuickAddText('Meeting ~wed', { now: NOW });
      expect(r.dueDate).toBe('2026-07-22');
    });

    it('resolves ~fri to the next Friday', () => {
      const r = parseQuickAddText('Ship ~fri', { now: NOW });
      expect(r.dueDate).toBe('2026-07-17');
    });

    it('resolves ISO YYYY-MM-DD', () => {
      const r = parseQuickAddText('Cut release ~2026-08-01', { now: NOW });
      expect(r.dueDate).toBe('2026-08-01');
    });

    it('resolves MM-DD to this year', () => {
      const r = parseQuickAddText('Cut release ~08-01', { now: NOW });
      expect(r.dueDate).toBe('2026-08-01');
    });

    it('records unresolved token for garbage', () => {
      const r = parseQuickAddText('Fix ~nextweek bug', { now: NOW });
      expect(r.dueDate).toBeUndefined();
      expect(r.dueDateRaw).toBe('nextweek');
      expect(r.unresolved).toContain('~nextweek');
      // The token IS still stripped from the title — we don't want raw ~token
      // text bleeding into the GitLab issue title.
      expect(r.title).toBe('Fix bug');
    });

    it('rejects an impossible calendar date (Feb 31)', () => {
      const r = parseQuickAddText('~2026-02-31', { now: NOW });
      expect(r.dueDate).toBeUndefined();
    });
  });

  describe('!!priority', () => {
    it('accepts !!high and canonicalizes', () => {
      const r = parseQuickAddText('Fix !!high the bug', { now: NOW });
      expect(r.priority).toBe('high');
      expect(r.priorityRaw).toBe('high');
      expect(r.title).toBe('Fix the bug');
    });

    it('canonicalizes short forms (hi/lo/med) and letters', () => {
      expect(parseQuickAddText('!!hi', { now: NOW }).priority).toBe('high');
      expect(parseQuickAddText('!!lo', { now: NOW }).priority).toBe('low');
      expect(parseQuickAddText('!!med', { now: NOW }).priority).toBe('medium');
      expect(parseQuickAddText('!!u', { now: NOW }).priority).toBe('urgent');
    });

    it('maps p1..p4 to urgent/high/medium/low', () => {
      expect(parseQuickAddText('!!p1', { now: NOW }).priority).toBe('urgent');
      expect(parseQuickAddText('!!p2', { now: NOW }).priority).toBe('high');
      expect(parseQuickAddText('!!p3', { now: NOW }).priority).toBe('medium');
      expect(parseQuickAddText('!!p4', { now: NOW }).priority).toBe('low');
    });

    it('records unknown priority tokens as unresolved', () => {
      const r = parseQuickAddText('Fix !!banana bug', { now: NOW });
      expect(r.priority).toBeUndefined();
      expect(r.priorityRaw).toBe('banana');
      expect(r.unresolved).toContain('!!banana');
      expect(r.title).toBe('Fix bug');
    });

    it('!!critical is treated as urgent (common alias)', () => {
      expect(parseQuickAddText('!!critical', { now: NOW }).priority).toBe('urgent');
    });
  });

  describe('>status', () => {
    it('captures the token and canonicalizes to hyphen-lower', () => {
      const r = parseQuickAddText('Ship >doing today', { now: NOW });
      expect(r.status).toBe('doing');
      expect(r.statusRaw).toBe('doing');
      expect(r.title).toBe('Ship today');
    });

    it('normalizes underscore / mixedCase forms', () => {
      expect(parseQuickAddText('>In_Progress', { now: NOW }).status).toBe('in-progress');
      expect(parseQuickAddText('>InProgress', { now: NOW }).status).toBe('inprogress');
    });
  });

  describe('multi-token combo', () => {
    it('parses everything in one line, preserves order-independence', () => {
      const r = parseQuickAddText(
        'Fix login bug !EIP @kevin ##v2.0 ~fri !!high >doing\nRepros on Safari 17',
        { now: NOW },
      );
      expect(r.title).toBe('Fix login bug');
      expect(r.description).toBe('Repros on Safari 17');
      expect(r.projectMarker).toBe('EIP');
      expect(r.assignees).toEqual(['kevin']);
      expect(r.milestone).toBe('v2.0');
      expect(r.dueDate).toBe('2026-07-17');
      expect(r.priority).toBe('high');
      expect(r.status).toBe('doing');
      expect(r.unresolved).toEqual([]);
    });

    it('empty input returns an empty-ish shape without throwing', () => {
      const r = parseQuickAddText('', { now: NOW });
      expect(r.title).toBe('');
      expect(r.assignees).toEqual([]);
      expect(r.unresolved).toEqual([]);
    });
  });
});

describe('resolveDateToken (edge cases beyond the parseQuickAddText suite)', () => {
  it('is case-insensitive', () => {
    expect(resolveDateToken('FRIDAY', NOW)).toBe('2026-07-17');
    expect(resolveDateToken('TODAY', NOW)).toBe('2026-07-15');
  });

  it('accepts YYYY/MM/DD with forward slashes', () => {
    expect(resolveDateToken('2026/07/22', NOW)).toBe('2026-07-22');
  });

  it('accepts M/D single-digit forms', () => {
    // NOW is 2026-07-15. `~7/4` in the second half of July resolves to
    // 2026-07-04 (the past). We do NOT auto-roll to next year; that's an
    // explicit user choice they can make by typing the full year. Better
    // predictable than magical here.
    expect(resolveDateToken('7/4', NOW)).toBe('2026-07-04');
  });

  it('null on gibberish', () => {
    expect(resolveDateToken('banana', NOW)).toBeNull();
    expect(resolveDateToken('', NOW)).toBeNull();
  });
});
