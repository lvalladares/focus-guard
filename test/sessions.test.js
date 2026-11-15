import { describe, it, expect } from 'vitest';
import {
  emptyBlockState,
  deriveBlockRuntime,
  activateBlockSnooze,
  endBlockSnooze,
  addBlockUsage,
  reconcileBlockStates,
  reconcile,
  isOverrideActive,
} from '../src/lib/sessions.js';

const NOW = 1700000000000;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function makeBlock(overrides = {}) {
  return {
    id: 'b1',
    name: 'Social',
    enabled: true,
    persistent: false,
    sites: [],
    schedule: { alwaysActive: false, windows: [] },
    timeLimit: { enabled: false, minutes: 20, periodHours: 8 },
    snooze: { enabled: false, durationMinutes: 5, maxCount: 2, periodHours: 4 },
    ...overrides,
  };
}

describe('deriveBlockRuntime', () => {
  it('returns blocked when neither timeLimit nor snooze is enabled', () => {
    const rt = deriveBlockRuntime(makeBlock(), emptyBlockState(), NOW);
    expect(rt.state).toBe('blocked');
  });

  it('allows via global time limit budget first, then falls back to snooze once exhausted', () => {
    const block = makeBlock({
      timeLimit: { enabled: true, minutes: 20, periodHours: 8 },
      snooze: { enabled: true, durationMinutes: 5, maxCount: 2, periodHours: 4 },
    });

    const fresh = deriveBlockRuntime(block, emptyBlockState(), NOW);
    expect(fresh.state).toBe('budget');
    expect(fresh.budgetRemainingMs).toBe(20 * MIN);

    const usedHalf = addBlockUsage(block, emptyBlockState(), 10 * MIN, NOW);
    const halfRt = deriveBlockRuntime(block, usedHalf, NOW + 10 * MIN);
    expect(halfRt.state).toBe('budget');
    expect(halfRt.budgetRemainingMs).toBe(10 * MIN);
    expect(halfRt.budgetResetAt).toBe(NOW + 8 * HOUR);

    const exhausted = addBlockUsage(block, usedHalf, 15 * MIN, NOW + 25 * MIN);
    const exRt = deriveBlockRuntime(block, exhausted, NOW + 25 * MIN);
    expect(exRt.state).toBe('snoozable');
    expect(exRt.snoozesLeft).toBe(2);
    expect(exRt.snoozeDurationMinutes).toBe(5);
    expect(exRt.budgetResetAt).toBe(NOW + 8 * HOUR);

    // Budget resets automatically 8 hours after window start
    const resetRt = deriveBlockRuntime(block, exhausted, NOW + 8 * HOUR);
    expect(resetRt.state).toBe('budget');
    expect(resetRt.budgetRemainingMs).toBe(20 * MIN);
  });

  it('tracks snooze activations across continuous wall-clock time', () => {
    const block = makeBlock({
      snooze: { enabled: true, durationMinutes: 5, maxCount: 2, periodHours: 4 },
    });

    const act1 = activateBlockSnooze(block, emptyBlockState(), NOW);
    expect(act1.ok).toBe(true);
    expect(act1.snooze.endsAt).toBe(NOW + 5 * MIN);

    const during1 = deriveBlockRuntime(block, act1.state, NOW + 2 * MIN);
    expect(during1.state).toBe('snooze');
    expect(during1.remainingMs).toBe(3 * MIN);
    expect(during1.snoozesLeft).toBe(1);

    const after1 = deriveBlockRuntime(block, act1.state, NOW + 6 * MIN);
    expect(after1.state).toBe('snoozable');
    expect(after1.snoozesLeft).toBe(1);

    const act2 = activateBlockSnooze(block, act1.state, NOW + 10 * MIN);
    expect(act2.ok).toBe(true);

    const after2 = deriveBlockRuntime(block, act2.state, NOW + 16 * MIN);
    expect(after2.state).toBe('snoozes-exhausted');
    expect(after2.snoozesLeft).toBe(0);
    expect(after2.nextSnoozeAt).toBe(NOW + 4 * HOUR);

    // Trying to activate a 3rd snooze fails
    const act3 = activateBlockSnooze(block, act2.state, NOW + 16 * MIN);
    expect(act3.ok).toBe(false);

    // 4 hours after the first snooze, 1 slot frees up
    const unlocked = deriveBlockRuntime(block, act2.state, NOW + 4 * HOUR + 1);
    expect(unlocked.state).toBe('snoozable');
    expect(unlocked.snoozesLeft).toBe(1);
  });

  it('ends an active snooze early while preserving snooze quota consumption', () => {
    const block = makeBlock({
      snooze: { enabled: true, durationMinutes: 10, maxCount: 1, periodHours: 4 },
    });
    const act = activateBlockSnooze(block, emptyBlockState(), NOW);
    const ended = endBlockSnooze(act.state, NOW + MIN);
    const rt = deriveBlockRuntime(block, ended, NOW + MIN);
    expect(rt.state).toBe('snoozes-exhausted');
    expect(rt.snoozesLeft).toBe(0);
  });
});

describe('reconcileBlockStates', () => {
  it('clears expired snoozes, expired snoozeHistory, and expired usageWindows', () => {
    const block = makeBlock({
      timeLimit: { enabled: true, minutes: 20, periodHours: 8 },
      snooze: { enabled: true, durationMinutes: 5, maxCount: 2, periodHours: 4 },
    });
    const state = {
      snooze: { startedAt: NOW, endsAt: NOW + 5 * MIN, durationMinutes: 5 },
      snoozeHistory: [NOW],
      usageWindow: { startedAt: NOW, usedMs: 15 * MIN },
      updatedAt: NOW,
    };

    const { blockStates, changed, changes } = reconcileBlockStates({ blocks: [block] }, { b1: state }, NOW + 10 * HOUR);
    expect(changed).toBe(true);
    expect(changes.some((c) => c.type === 'snooze-ended')).toBe(true);
    expect(changes.some((c) => c.type === 'budget-reset')).toBe(true);
    expect(blockStates.b1.snooze).toBeNull();
    expect(blockStates.b1.snoozeHistory).toEqual([]);
    expect(blockStates.b1.usageWindow).toBeNull();
  });
});

describe('reconcile & override', () => {
  it('clears expired override', () => {
    const { runtime } = reconcile({ override: { until: NOW - 1 } }, NOW);
    expect(runtime.override).toBeNull();
    expect(isOverrideActive({ override: { until: NOW + 1 } }, NOW)).toBe(true);
    expect(isOverrideActive({ override: { until: NOW - 1 } }, NOW)).toBe(false);
  });
});
