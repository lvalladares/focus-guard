// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createBlockedController } from '../../src/pages/blocked/blocked.js';

const NOW = new Date('2026-11-09T10:00:00').getTime();
const MIN = 60 * 1000;

function loadFixture() {
  const html = readFileSync(resolve(process.cwd(), 'src/pages/blocked/blocked.html'), 'utf8');
  const body = html.replace(/^[\s\S]*?<body[^>]*>/, '').replace(/<\/body>[\s\S]*$/, '');
  document.documentElement.innerHTML = body;
}

const baseConfig = {
  master: { enabled: false },
  schedule: { windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }] },
  groups: [
    { id: 'g1', domain: 'blocked.com', includeBaseHost: true, includeAllSubdomains: false, subdomains: [], whitelist: [], level: 'total' },
  ],
  wallpaper: { mode: 'builtin', value: 'aurora' },
};

function makeDeps({ config = baseConfig, runtime = { sessions: {}, cooldowns: {}, override: null }, target = 'https://blocked.com/x' } = {}) {
  const deps = {
    document,
    location: { hash: `#${encodeURIComponent(target)}` },
    storage: { get: async () => ({ focusConfig: config, focusRuntime: runtime }) },
    now: () => NOW,
    navigate: vi.fn(),
    historyBack: vi.fn(),
    settingsUrl: 'chrome-extension://abc/settings.html',
    gateUrlOf: (t) => `chrome-extension://abc/gate.html#${encodeURIComponent(t)}`,
    wallpaperFor: () => 'chrome-extension://abc/assets/wallpapers/aurora.svg',
    subscribe: vi.fn(),
  };
  return deps;
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
  it('renders the total-block state with the focus window end', async () => {
    await render(makeDeps());
    expect(document.getElementById('headline').textContent).toBe('This site is blocked');
    expect(document.getElementById('detail').innerHTML).toContain('blocked.com');
    expect(document.getElementById('detail').innerHTML).toContain('17:00');
    expect(document.getElementById('btn-dose').classList.contains('hidden')).toBe(true);
  });

  it('renders the cooldown variant with a live countdown', async () => {
    const config = {
      ...baseConfig,
      groups: [{ ...baseConfig.groups[0], level: 'partial' }],
    };
    const runtime = { sessions: {}, cooldowns: { g1: { startedAt: NOW - MIN, until: NOW + 10 * MIN } }, override: null };
    await render(makeDeps({ config, runtime }));
    expect(document.getElementById('headline').textContent).toBe('You already had your dose');
    expect(document.getElementById('countdown').textContent).toBe('10:00');
    expect(document.getElementById('countdown-note').textContent).toContain('ask again');
  });

  it('renders a quote and wallpaper', async () => {
    await render(makeDeps());
    expect(document.getElementById('quote').textContent).not.toBe('');
    expect(document.getElementById('quote-author').textContent).not.toBe('');
    expect(document.getElementById('wallpaper-img').src).toContain('aurora.svg');
  });

  it('shows the continue button and navigates when blocking is off', async () => {
    const offConfig = { ...baseConfig, schedule: { windows: [] } };
    const deps = makeDeps({ config: offConfig });
    await render(deps);
    expect(document.getElementById('headline').textContent).toBe('You are free to continue');
    document.getElementById('btn-continue').click();
    expect(deps.navigate).toHaveBeenCalledWith('https://blocked.com/x');
  });

  it('offers a dose when the cooldown is over and the group is partial', async () => {
    const config = {
      ...baseConfig,
      groups: [{ ...baseConfig.groups[0], level: 'partial' }],
    };
    const deps = makeDeps({ config });
    await render(deps);
    expect(document.getElementById('headline').textContent).toBe('Focused work beats doomscrolling');
    document.getElementById('btn-dose').click();
    expect(deps.navigate).toHaveBeenCalledWith(deps.gateUrlOf('https://blocked.com/x'));
  });

  it('goes back to work when the back button is pressed', async () => {
    const deps = makeDeps();
    await render(deps);
    document.getElementById('btn-back').click();
    expect(deps.historyBack).toHaveBeenCalled();
  });

  it('renders a friendly state when opened directly without a target', async () => {
    const deps = makeDeps();
    deps.location.hash = '';
    await render(deps);
    expect(document.getElementById('headline').textContent).toBe('Nothing to block here');
    expect(document.getElementById('detail').textContent).toContain('Add distracting sites');
  });

  it('links to the settings page', async () => {
    await render(makeDeps());
    expect(document.getElementById('btn-settings').href).toBe('chrome-extension://abc/settings.html');
  });
});
