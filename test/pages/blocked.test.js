// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createBlockedController } from '../../src/pages/blocked/blocked.js';
import { activateBlockSnooze, addBlockUsage, emptyBlockState } from '../../src/lib/sessions.js';

const NOW = new Date('2026-11-09T10:00:00').getTime();
const MIN = 60 * 1000;

function loadFixture() {
  const html = readFileSync(resolve(process.cwd(), 'src/pages/blocked/blocked.html'), 'utf8');
  const body = html.replace(/^[\s\S]*?<body[^>]*>/, '').replace(/<\/body>[\s\S]*$/, '');
  document.documentElement.innerHTML = body;
}

function makeBlock(overrides = {}) {
  return {
    id: 'b1',
    name: 'Social',
    enabled: true,
    persistent: false,
    sites: [
      { id: 's1', domain: 'blocked.com', includeBaseHost: true, includeAllSubdomains: false, subdomains: [], whitelist: [] },
    ],
    schedule: { alwaysActive: false, windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }] },
    timeLimit: { enabled: false, minutes: 20, periodHours: 8 },
    snooze: { enabled: false, durationMinutes: 5, maxCount: 2, periodHours: 4 },
    ...overrides,
  };
}

function makeConfig(blocks, extra = {}) {
  return {
    schemaVersion: 3,
    master: { enabled: false },
    antiUninstall: { enabled: false },
    blocks,
    wallpaper: { mode: 'builtin', value: 'aurora' },
    ...extra,
  };
}

function makeDeps({
  config = makeConfig([makeBlock()]),
  blockStates = {},
  runtime = { override: null },
  target = 'https://blocked.com/x',
  sendMessage = vi.fn().mockResolvedValue({ ok: true }),
} = {}) {
  return {
    document,
    location: { hash: `#${encodeURIComponent(target)}` },
    storage: { get: async () => ({ focusConfig: config, blockStates, focusRuntime: runtime }) },
    now: () => NOW,
    navigate: vi.fn(),
    historyBack: vi.fn(),
    sendMessage,
    settingsUrl: 'chrome-extension://abc/settings.html',
    wallpaperFor: () => 'chrome-extension://abc/assets/wallpapers/aurora.svg',
    subscribe: vi.fn(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  loadFixture();
});

afterEach(() => {
  vi.useRealTimers();
});

async function render(deps) {
  const controller = createBlockedController(deps);
  await controller.refresh();
  return controller;
}

describe('blocked controller', () => {
  it('renders a hard block with block name and window end', async () => {
    await render(makeDeps());
    expect(document.getElementById('headline').textContent).toBe('This site is blocked');
    expect(document.getElementById('detail').innerHTML).toContain('Social');
    expect(document.getElementById('detail').innerHTML).toContain('17:00');
    expect(document.getElementById('btn-snooze').classList.contains('hidden')).toBe(true);
  });

  it('offers snooze with configured duration and activates snooze on click', async () => {
    const config = makeConfig([makeBlock({ snooze: { enabled: true, durationMinutes: 5, maxCount: 2, periodHours: 4 } })]);
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, endsAt: NOW + 5 * MIN });
    const deps = makeDeps({ config, sendMessage });
    await render(deps);

    const snoozeBtn = document.getElementById('btn-snooze');
    expect(snoozeBtn.classList.contains('hidden')).toBe(false);
    expect(snoozeBtn.textContent).toBe('Snooze 5 min (2/2 left)');

    snoozeBtn.click();
    await vi.waitFor(() => expect(deps.navigate).toHaveBeenCalledWith('https://blocked.com/x'));
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'snooze:start',
      blockIds: ['b1'],
      targetUrl: 'https://blocked.com/x',
    });
  });

  it('shows exhausted snoozes with a countdown to next unlock', async () => {
    const block = makeBlock({ snooze: { enabled: true, durationMinutes: 5, maxCount: 1, periodHours: 4 } });
    const { state } = activateBlockSnooze(block, emptyBlockState(), NOW - 10 * MIN);
    await render(makeDeps({ config: makeConfig([block]), blockStates: { b1: state } }));

    expect(document.getElementById('headline').textContent).toBe('No snoozes left');
    expect(document.getElementById('btn-snooze').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('countdown').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('countdown').textContent).toBe('3:50:00');
  });

  it('shows time limit reached with reset countdown and snooze option when both are enabled', async () => {
    const block = makeBlock({
      timeLimit: { enabled: true, minutes: 20, periodHours: 8 },
      snooze: { enabled: true, durationMinutes: 5, maxCount: 1, periodHours: 4 },
    });
    const spent = addBlockUsage(block, emptyBlockState(), 20 * MIN, NOW - 20 * MIN);
    // Shift startedAt so reset is 7h 40m from NOW
    spent.usageWindow.startedAt = NOW - 20 * MIN;
    await render(makeDeps({ config: makeConfig([block]), blockStates: { b1: spent } }));

    expect(document.getElementById('headline').textContent).toBe('Time limit reached');
    expect(document.getElementById('btn-snooze').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('countdown').textContent).toBe('7:40:00');
  });

  it('renders anti-uninstall lock screen for chrome://extensions', async () => {
    const config = makeConfig([makeBlock({ persistent: true })], { antiUninstall: { enabled: true } });
    await render(makeDeps({ config, target: 'chrome://extensions/' }));
    expect(document.getElementById('headline').textContent).toBe('Extensions page is locked');
    expect(document.getElementById('btn-snooze').classList.contains('hidden')).toBe(true);
  });

  it('shows continue button when blocking is off', async () => {
    const offConfig = makeConfig([makeBlock({ schedule: { alwaysActive: false, windows: [] } })]);
    const deps = makeDeps({ config: offConfig });
    await render(deps);
    expect(document.getElementById('headline').textContent).toBe('You are free to continue');
    document.getElementById('btn-continue').click();
    expect(deps.navigate).toHaveBeenCalledWith('https://blocked.com/x');
  });

  it('renders friendly state without target and handles back button', async () => {
    const deps = makeDeps();
    deps.location.hash = '';
    await render(deps);
    expect(document.getElementById('headline').textContent).toBe('Nothing to block here');
    document.getElementById('btn-back').click();
    expect(deps.historyBack).toHaveBeenCalled();
  });
});
