import { describe, expect, test } from 'bun:test';

import { filterDraftStartersForClaude } from './draftStarters';

/**
 * A Claude draft cannot run a Goal, so the /craft-goal starter chip leaves the
 * row for it — including a copy the user pinned in the project group. Every
 * other starter is a plain prompt or skill and stays.
 */

type Starter = { id: string; ref: { type: 'command' | 'skill'; name: string } };

const starters: Starter[] = [
  { id: 'global:command:explore', ref: { type: 'command', name: 'explore' } },
  { id: 'global:command:craft-goal', ref: { type: 'command', name: 'craft-goal' } },
  { id: 'project:command:craft-goal', ref: { type: 'command', name: 'craft-goal' } },
  { id: 'project:skill:craft-goal', ref: { type: 'skill', name: 'craft-goal' } },
  { id: 'global:command:review', ref: { type: 'command', name: 'review' } },
];

describe('filterDraftStartersForClaude', () => {
  test('drops the craft-goal command chips, keeping skills and other commands', () => {
    expect(filterDraftStartersForClaude(starters, true).map((item) => item.id)).toEqual([
      'global:command:explore',
      'project:skill:craft-goal',
      'global:command:review',
    ]);
  });

  test('keeps every chip for an OpenCode draft', () => {
    expect(filterDraftStartersForClaude(starters, false)).toEqual(starters);
  });

  test('does not mutate the input list', () => {
    const input = [...starters];
    filterDraftStartersForClaude(input, true);
    expect(input).toEqual(starters);
  });
});
