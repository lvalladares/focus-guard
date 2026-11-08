// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  computeStatus,
  statusSummary,
  createReflectionModal,
  collectGroupsFromDom,
  collectScheduleFromDom,
  escapeHtml,
} from '../../src/pages/settings/settings-logic.js';
import { defaultConfig } from '../../src/lib/config.js';
import { startSession } from '../../src/lib/sessions.js';

const NOW = new Date('2026-11-09T10:00:00').getTime();
const MIN = 60 * 1000;

const workSchedule = { windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }] };

function config(overrides = {}) {
  return {
    ...defaultConfig(),
    schedule: workSchedule,
    groups: [
      { id: 'g1', domain: 'reddit.com', includeBaseHost: true, includeAllSubdomains: false, subdomains: [], whitelist: [], level: 'partial' },
    ],
    ...overrides,
  };
}

describe('computeStatus', () => {
  it('reports scheduled blocking inside the window', () => {
    const status = computeStatus(config(), {}, NOW);
    expect(status.inSchedule).toBe(true);
    expect(status.blockingActive).toBe(true);
    expect(status.windowEnd).toEqual(new Date('2026-11-09T17:00:00'));
    expect(status.activeSessions).toEqual([]);
    expect(status.cooldowns).toEqual([]);
  });

  it('reports manual blocking outside the window when master is on', () => {
    const evening = new Date('2026-11-09T20:00:00').getTime();
    const status = computeStatus(config({ master: { enabled: true } }), {}, evening);
    expect(status.inSchedule).toBe(false);
    expect(status.blockingActive).toBe(true);
    expect(status.windowEnd).toBeNull();
  });

  it('reports paused blocking with an active override', () => {
    const status = computeStatus(config(), { override: { until: NOW + 60 * MIN } }, NOW);
    expect(status.inSchedule).toBe(true);
    expect(status.overrideActive).toBe(true);
    expect(status.blockingActive).toBe(false);
    expect(status.overrideUntil).toBe(NOW + 60 * MIN);
  });

  it('lists active sessions and cooldowns with their domains', () => {
    const runtime = {
      sessions: { g1: startSession({ groupId: 'g1', minutes: 10, now: NOW - 5 * MIN }) },
      cooldowns: {},
      override: null,
    };
    const status = computeStatus(config(), runtime, NOW);
    expect(status.activeSessions).toHaveLength(1);
    expect(status.activeSessions[0].domain).toBe('reddit.com');
    expect(status.activeSessions[0].remainingMs).toBe(5 * MIN);
    expect(status.activeSessions[0].minutes).toBe(10);

    const cooldownRuntime = { sessions: {}, cooldowns: { g1: { startedAt: NOW, until: NOW + 3 * MIN } }, override: null };
    const cooldownStatus = computeStatus(config(), cooldownRuntime, NOW);
    expect(cooldownStatus.cooldowns).toHaveLength(1);
    expect(cooldownStatus.cooldowns[0].remainingMs).toBe(3 * MIN);
  });

  it('finds the next schedule change', () => {
    const status = computeStatus(config(), {}, NOW);
    expect(status.nextChange).toEqual(new Date('2026-11-09T17:00:00'));
    const eveningStatus = computeStatus(config(), {}, new Date('2026-11-09T18:00:00').getTime());
    expect(eveningStatus.nextChange).toEqual(new Date('2026-11-10T09:00:00'));
  });
});

describe('statusSummary', () => {
  it('describes each state', () => {
    expect(statusSummary({ blockingActive: true, inSchedule: true, windowEnd: new Date('2026-11-09T17:00:00') }).title).toBe('Focus mode is on');
    expect(statusSummary({ blockingActive: false, inSchedule: false, overrideActive: false }).title).toBe('Blocking is off');
    expect(statusSummary({ blockingActive: false, inSchedule: true, overrideActive: true, overrideUntil: NOW + 60 * MIN }).title).toBe('Blocking is paused');
    expect(statusSummary({ blockingActive: true, inSchedule: false }).title).toBe('Focus mode is on');
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

  function open(overrides = {}) {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const modal = createReflectionModal({ document, onConfirm, onCancel, seconds: 30, ...overrides });
    return { modal, onConfirm, onCancel };
  }

  it('renders a 30 second countdown with the confirm button disabled', () => {
    const { onConfirm } = open();
    const overlay = document.querySelector('.reflection-overlay');
    expect(overlay).not.toBeNull();
    expect(document.querySelector('[data-ref="countdown"]').textContent).toBe('0:30');
    const confirmBtn = document.querySelector('[data-ref="confirm"]');
    expect(confirmBtn.disabled).toBe(true);
    confirmBtn.click();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('enables confirmation after 30 seconds and fires the callback', () => {
    const { modal, onConfirm } = open();
    vi.advanceTimersByTime(30 * 1000);
    const confirmBtn = document.querySelector('[data-ref="confirm"]');
    expect(confirmBtn.disabled).toBe(false);
    expect(document.querySelector('[data-ref="countdown"]').textContent).toBe('Ready');
    confirmBtn.click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.reflection-overlay')).toBeNull();
    modal.destroy();
  });

  it('rotates quotes while waiting', () => {
    open();
    const first = document.querySelector('[data-ref="quote"]').textContent;
    vi.advanceTimersByTime(5000);
    const second = document.querySelector('[data-ref="quote"]').textContent;
    expect(second).not.toBe(first);
  });

  it('cancels without confirming', () => {
    const { onConfirm, onCancel } = open();
    document.querySelector('[data-ref="cancel"]').click();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.reflection-overlay')).toBeNull();
  });
});

describe('collectGroupsFromDom', () => {
  it('collects group state from a rendered card', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <div class="group" data-group-id="g1">
        <input type="text" class="group-domain" value="reddit.com">
        <button class="level-pill on" data-level="partial"></button>
        <button class="level-pill" data-level="total"></button>
        <input type="checkbox" class="group-include-base" checked>
        <input type="checkbox" class="group-include-subdomains">
        <span class="chip" data-kind="subdomain" data-value="old.reddit.com"></span>
        <span class="chip" data-kind="subdomain" data-value="sh.reddit.com"></span>
        <span class="chip" data-kind="whitelist" data-value="/r/learn*"></span>
      </div>
      <div class="group">
        <input type="text" class="group-domain" value="news.com">
        <button class="level-pill on" data-level="total"></button>
        <input type="checkbox" class="group-include-base">
        <input type="checkbox" class="group-include-subdomains" checked>
      </div>
    `;
    document.body.appendChild(container);
    const groups = collectGroupsFromDom([...container.querySelectorAll('.group')], () => 'g_new');
    expect(groups).toEqual([
      {
        id: 'g1',
        domain: 'reddit.com',
        includeBaseHost: true,
        includeAllSubdomains: false,
        subdomains: ['old.reddit.com', 'sh.reddit.com'],
        whitelist: ['/r/learn*'],
        level: 'partial',
      },
      {
        id: 'g_new',
        domain: 'news.com',
        includeBaseHost: false,
        includeAllSubdomains: true,
        subdomains: [],
        whitelist: [],
        level: 'total',
      },
    ]);
  });
});

describe('collectScheduleFromDom', () => {
  it('collects ranges per day and flags problems', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <div class="day-row" data-day="1">
        <div class="day-ranges">
          <div class="schedule-range">
            <input type="time" class="range-start" value="09:00">
            <input type="time" class="range-end" value="17:00">
          </div>
          <div class="schedule-range">
            <input type="time" class="range-start" value="">
            <input type="time" class="range-end" value="20:00">
          </div>
        </div>
      </div>
      <div class="day-row" data-day="2">
        <div class="day-ranges">
          <div class="schedule-range">
            <input type="time" class="range-start" value="22:00">
            <input type="time" class="range-end" value="06:00">
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(container);
    const { windows, errors } = collectScheduleFromDom([...container.querySelectorAll('.day-row')]);
    expect(windows).toEqual([
      { days: [1], start: '09:00', end: '17:00' },
      { days: [2], start: '22:00', end: '06:00' },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('needs both start and end');
  });
});

describe('escapeHtml', () => {
  it('escapes dangerous characters', () => {
    expect(escapeHtml(`<img src="x" onerror='alert(1)'>`)).toBe(
      '&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt;',
    );
  });
});
