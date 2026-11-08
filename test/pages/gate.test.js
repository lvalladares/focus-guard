// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGateController } from '../../src/pages/gate/gate.js';

const NOW = new Date('2026-11-09T10:00:00').getTime();

function loadFixture() {
  const html = readFileSync(resolve(process.cwd(), 'src/pages/gate/gate.html'), 'utf8');
  const body = html.replace(/^[\s\S]*?<body[^>]*>/, '').replace(/<\/body>[\s\S]*$/, '');
  document.documentElement.innerHTML = body;
}

const baseConfig = {
  master: { enabled: false },
  schedule: { windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }] },
  groups: [
    { id: 'g1', domain: 'reddit.com', includeBaseHost: true, includeAllSubdomains: false, subdomains: [], whitelist: [], level: 'partial' },
  ],
  wallpaper: { mode: 'builtin', value: 'aurora' },
};

function makeDeps({ config = baseConfig, runtime = { sessions: {}, cooldowns: {}, override: null }, response, target = 'https://reddit.com/r/all' } = {}) {
  const sendSpy = vi.fn().mockResolvedValue(response || { ok: true });
  const deps = {
    document,
    location: { hash: `#${encodeURIComponent(target)}` },
    storage: { get: async () => ({ focusConfig: config, focusRuntime: runtime }) },
    now: () => NOW,
    navigate: vi.fn(),
    historyBack: vi.fn(),
    sendMessage: sendSpy,
    blockedUrlOf: (t) => `chrome-extension://abc/blocked.html#${encodeURIComponent(t)}`,
    wallpaperFor: () => 'chrome-extension://abc/assets/wallpapers/aurora.svg',
  };
  return { deps, sendSpy };
}

beforeEach(() => {
  loadFixture();
});

describe('gate controller', () => {
  it('shows the domain and the focus window end while scheduled', async () => {
    const { deps } = makeDeps();
    const controller = createGateController(deps);
    await controller.refresh();
    const detail = document.getElementById('detail').innerHTML;
    expect(detail).toContain('reddit.com');
    expect(detail).toContain('17:00');
    expect(document.querySelectorAll('.dose:not([disabled])')).toHaveLength(3);
  });

  it('starts a session with the chosen dose and navigates to the target', async () => {
    const { deps, sendSpy } = makeDeps({ response: { ok: true, endsAt: NOW + 10 * 60000 } });
    const controller = createGateController(deps);
    await controller.refresh();
    document.querySelector('.dose[data-minutes="10"]').click();
    await vi.waitFor(() => expect(deps.navigate).toHaveBeenCalled());
    expect(sendSpy).toHaveBeenCalledWith({ type: 'session:start', groupId: 'g1', minutes: 10, targetUrl: 'https://reddit.com/r/all' });
    expect(deps.navigate).toHaveBeenCalledWith('https://reddit.com/r/all');
  });

  it('redirects to the blocked page when the service worker reports a cooldown verdict', async () => {
    const { deps } = makeDeps({ response: { ok: false, verdict: 'cooldown' } });
    const controller = createGateController(deps);
    await controller.refresh();
    document.querySelector('.dose[data-minutes="20"]').click();
    await vi.waitFor(() => expect(deps.navigate).toHaveBeenCalled());
    expect(deps.navigate).toHaveBeenCalledWith(deps.blockedUrlOf('https://reddit.com/r/all'));
  });

  it('shows an error and re-enables doses when the session cannot start', async () => {
    const { deps } = makeDeps({ response: { ok: false, error: 'nope' } });
    const controller = createGateController(deps);
    await controller.refresh();
    const button = document.querySelector('.dose[data-minutes="30"]');
    button.click();
    await vi.waitFor(() => expect(document.getElementById('warning').textContent).toContain('nope'));
    expect(document.querySelectorAll('.dose.disabled')).toHaveLength(0);
  });

  it('redirects away when the verdict is no longer gate', async () => {
    const totalConfig = {
      ...baseConfig,
      groups: [{ ...baseConfig.groups[0], level: 'total' }],
    };
    const { deps } = makeDeps({ config: totalConfig });
    createGateController(deps);
    await vi.waitFor(() => expect(deps.navigate).toHaveBeenCalled());
    expect(deps.navigate).toHaveBeenCalledWith(deps.blockedUrlOf('https://reddit.com/r/all'));
  });

  it('navigates to the target when blocking is off', async () => {
    const offConfig = { ...baseConfig, schedule: { windows: [] } };
    const { deps } = makeDeps({ config: offConfig });
    createGateController(deps);
    await vi.waitFor(() => expect(deps.navigate).toHaveBeenCalledWith('https://reddit.com/r/all'));
  });

  it('goes back when dismissing', async () => {
    const { deps } = makeDeps();
    const controller = createGateController(deps);
    await controller.refresh();
    document.getElementById('btn-dismiss').click();
    expect(deps.historyBack).toHaveBeenCalled();
  });

  it('renders a placeholder when opened directly without a target', async () => {
    const { deps } = makeDeps();
    deps.location.hash = '';
    const controller = createGateController(deps);
    await controller.refresh();
    expect(document.getElementById('detail').textContent).toContain('opened the Focus Guard gate directly');
    expect(document.querySelectorAll('.dose[disabled]')).toHaveLength(3);
  });
});
