// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  computeStatus,
  statusSummary,
  createReflectionModal,
  collectBlocksFromDom,
  escapeHtml,
} from '../../src/pages/settings/settings-logic.js';
import { defaultConfig } from '../../src/lib/config.js';
import { activateBlockSnooze, emptyBlockState } from '../../src/lib/sessions.js';

const NOW = new Date('2026-11-09T10:00:00').getTime();
const MIN = 60 * 1000;

const workSchedule = { alwaysActive: false, windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }] };

function config(overrides = {}) {
  return {
    ...defaultConfig(),
    blocks: [
      {
        id: 'b1',
        name: 'Social',
        enabled: true,
        persistent: false,
        sites: [{ id: 's1', domain: 'reddit.com', includeBaseHost: true, includeAllSubdomains: false, subdomains: [], whitelist: [] }],
        schedule: workSchedule,
        timeLimit: { enabled: false, minutes: 20, periodHours: 8 },
        snooze: { enabled: true, durationMinutes: 5, maxCount: 2, periodHours: 4 },
      },
    ],
    ...overrides,
  };
}

describe('computeStatus', () => {
  it('reports active scheduled blocks inside the window', () => {
    const status = computeStatus(config(), {}, NOW);
    expect(status.inSchedule).toBe(true);
    expect(status.blockingActive).toBe(true);
    expect(status.activeBlockCount).toBe(1);
    expect(status.hasLockedBlock).toBe(false);
    expect(status.windowEnd).toEqual(new Date('2026-11-09T17:00:00'));
  });

  it('reports locked persistent blocks and anti-uninstall status', () => {
    const cfg = config({
      antiUninstall: { enabled: true },
      blocks: [{ ...config().blocks[0], persistent: true }],
    });
    const status = computeStatus(cfg, { override: { until: NOW + 60 * MIN } }, NOW);
    expect(status.hasLockedBlock).toBe(true);
    expect(status.lockedBlockCount).toBe(1);
    expect(status.blockingActive).toBe(true);
    expect(status.antiUninstallActive).toBe(true);
  });

  it('reports paused non-persistent blocks with an active override', () => {
    const status = computeStatus(config(), { override: { until: NOW + 60 * MIN } }, NOW);
    expect(status.inSchedule).toBe(true);
    expect(status.overrideActive).toBe(true);
    expect(status.blockingActive).toBe(false);
  });

  it('lists active snoozes and budgets', () => {
    const cfg = config({
      blocks: [
        config().blocks[0],
        {
          ...config().blocks[0],
          id: 'b2',
          name: 'News',
          timeLimit: { enabled: true, minutes: 20, periodHours: 8 },
          snooze: { enabled: false, durationMinutes: 5, maxCount: 1, periodHours: 4 },
        },
      ],
    });
    const { state } = activateBlockSnooze(cfg.blocks[0], emptyBlockState(), NOW - 2 * MIN);
    const status = computeStatus(cfg, {}, NOW, { b1: state });
    expect(status.activeSnoozes).toHaveLength(1);
    expect(status.activeSnoozes[0].blockName).toBe('Social');
    expect(status.activeSnoozes[0].remainingMs).toBe(3 * MIN);
    expect(status.activeBudgets).toHaveLength(1);
    expect(status.activeBudgets[0].blockName).toBe('News');
    expect(status.activeBudgets[0].remainingMs).toBe(20 * MIN);
  });
});

describe('statusSummary', () => {
  it('describes locked, scheduled, paused, manual, and off states', () => {
    expect(statusSummary({ blockingActive: true, hasLockedBlock: true, lockedBlockCount: 1 }).title).toBe('Focus mode is locked on');
    expect(statusSummary({ blockingActive: true, inSchedule: true, windowEnd: new Date('2026-11-09T17:00:00') }).title).toBe('Focus mode is on');
    expect(statusSummary({ blockingActive: false, inSchedule: false, overrideActive: false }).title).toBe('Blocking is off');
    expect(statusSummary({ blockingActive: false, inSchedule: true, overrideActive: true, overrideUntil: NOW + 60 * MIN }).title).toBe('Blocking is paused');
  });
});

describe('createReflectionModal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('unlocks confirm after 30 seconds and fires callback', () => {
    const onConfirm = vi.fn();
    const modal = createReflectionModal({ document, onConfirm, onCancel: vi.fn(), seconds: 30 });
    const confirmBtn = document.querySelector('[data-ref="confirm"]');
    expect(confirmBtn.disabled).toBe(true);
    vi.advanceTimersByTime(30 * 1000);
    expect(confirmBtn.disabled).toBe(false);
    confirmBtn.click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    modal.destroy();
  });
});

describe('collectBlocksFromDom', () => {
  it('collects blocks, sites, windows, timeLimit, and snooze settings from DOM', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <div class="block-card" data-block-id="b1">
        <input type="text" class="block-name" value="Deep Work">
        <input type="checkbox" class="block-enabled" checked>
        <input type="checkbox" class="block-persistent" checked>
        <div class="site-card" data-site-id="s1">
          <input type="text" class="site-domain" value="reddit.com">
          <input type="checkbox" class="site-include-base" checked>
          <input type="checkbox" class="site-include-subdomains">
          <span class="chip" data-kind="subdomain" data-value="old.reddit.com"></span>
          <span class="chip" data-kind="whitelist" data-value="/r/learn*"></span>
        </div>
        <input type="checkbox" class="block-always-active">
        <div class="window-row">
          <button class="day-pill on" data-day="1"></button>
          <button class="day-pill on" data-day="3"></button>
          <input type="time" class="range-start" value="09:00">
          <input type="time" class="range-end" value="17:00">
        </div>
        <input type="checkbox" class="limit-enabled" checked>
        <input type="number" class="limit-minutes" value="20">
        <input type="number" class="limit-hours" value="8">
        <input type="checkbox" class="snooze-enabled" checked>
        <input type="number" class="snooze-duration" value="5">
        <input type="number" class="snooze-max" value="2">
        <input type="number" class="snooze-hours" value="4">
      </div>
    `;
    document.body.appendChild(container);
    const { blocks, scheduleErrors } = collectBlocksFromDom(
      [...container.querySelectorAll('.block-card')],
      { makeBlockId: () => 'b_new', makeSiteId: () => 's_new' },
    );
    expect(scheduleErrors).toEqual([]);
    expect(blocks).toEqual([
      {
        id: 'b1',
        name: 'Deep Work',
        enabled: true,
        persistent: true,
        sites: [
          {
            id: 's1',
            domain: 'reddit.com',
            includeBaseHost: true,
            includeAllSubdomains: false,
            subdomains: ['old.reddit.com'],
            whitelist: ['/r/learn*'],
          },
        ],
        schedule: {
          alwaysActive: false,
          windows: [{ days: [1, 3], start: '09:00', end: '17:00' }],
        },
        timeLimit: { enabled: true, minutes: 20, periodHours: 8 },
        snooze: { enabled: true, durationMinutes: 5, maxCount: 2, periodHours: 4 },
      },
    ]);
  });
});

describe('escapeHtml', () => {
  it('escapes HTML special characters', () => {
    expect(escapeHtml(`<img src="x" onerror='alert(1)'>`)).toBe(
      '&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt;',
    );
  });
});
