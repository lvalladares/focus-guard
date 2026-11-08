// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const code = readFileSync(resolve(process.cwd(), 'src/content/overlay-core.js'), 'utf8');

function loadCore() {
  const factory = new Function(`${code}\nreturn FocusOverlay;`);
  return factory();
}

const TARGET = 'https://reddit.com/r/productivity';
const NOW = 1700000000000;

function makeChrome({ runtime, response }) {
  return {
    storage: {
      local: {
        get: (keys, cb) => cb({ focusRuntime: runtime }),
      },
      onChanged: { addListener: vi.fn() },
    },
    runtime: {
      sendMessage: vi.fn((msg, cb) => cb(response)),
      lastError: null,
    },
  };
}

function makeDeps({ runtime = { sessions: {} }, response = {}, navigate } = {}) {
  return {
    chrome: makeChrome({ runtime, response }),
    document,
    location: { href: TARGET, replace: vi.fn() },
    navigate: navigate || vi.fn(),
    now: () => Date.now(),
    blockedPageUrl: () => 'chrome-extension://abc/blocked.html',
    setInterval: (fn, ms) => setInterval(fn, ms),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearInterval: (id) => clearInterval(id),
    clearTimeout: (id) => clearTimeout(id),
  };
}

let FocusOverlay;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  document.body.innerHTML = '';
  document.documentElement.querySelectorAll('#focus-guard-overlay-host').forEach((el) => el.remove());
  FocusOverlay = loadCore();
});

afterEach(() => {
  vi.useRealTimers();
});

function getOverlay() {
  const host = document.getElementById('focus-guard-overlay-host');
  if (!host) return null;
  return { host, card: host.shadowRoot.querySelector('.card'), time: host.shadowRoot.querySelector('.time') };
}

describe('focus overlay', () => {
  it('does nothing when no sessions exist', () => {
    const deps = makeDeps({ runtime: { sessions: {} } });
    FocusOverlay.create(deps);
    expect(deps.chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(document.getElementById('focus-guard-overlay-host')).toBeNull();
  });

  it('shows a countdown when the session has less than a minute left', () => {
    const response = { active: true, endsAt: NOW + 30 * 1000, domain: 'reddit.com', groupId: 'g1' };
    const deps = makeDeps({
      runtime: { sessions: { g1: {} } },
      response,
    });
    FocusOverlay.create(deps);
    const overlay = getOverlay();
    expect(overlay).not.toBeNull();
    expect(overlay.host.style.display).not.toBe('none');
    expect(overlay.time.textContent).toBe('0:30');
    expect(overlay.card.querySelector('.domain').textContent).toBe('reddit.com');
  });

  it('ticks the countdown down and redirects when time is up', () => {
    const navigate = vi.fn();
    const deps = makeDeps({
      runtime: { sessions: { g1: {} } },
      response: { active: true, endsAt: NOW + 30 * 1000, domain: 'reddit.com', groupId: 'g1' },
      navigate,
    });
    FocusOverlay.create(deps);
    vi.advanceTimersByTime(11 * 1000);
    expect(getOverlay().time.textContent).toBe('0:19');
    vi.advanceTimersByTime(19 * 1000);
    expect(navigate).toHaveBeenCalledWith(
      `chrome-extension://abc/blocked.html#${encodeURIComponent(TARGET)}`,
    );
  });

  it('stays hidden until the last minute when more time remains', () => {
    const deps = makeDeps({
      runtime: { sessions: { g1: {} } },
      response: { active: true, endsAt: NOW + 5 * 60 * 1000, domain: 'reddit.com', groupId: 'g1' },
    });
    FocusOverlay.create(deps);
    const overlay = getOverlay();
    expect(overlay).not.toBeNull();
    expect(overlay.host.style.display).toBe('none');
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(overlay.host.style.display).not.toBe('none');
    expect(overlay.time.textContent).toBe('1:00');
  });

  it('warns with a highlighted countdown in the last seconds', () => {
    const deps = makeDeps({
      runtime: { sessions: { g1: {} } },
      response: { active: true, endsAt: NOW + 30 * 1000, domain: 'reddit.com', groupId: 'g1' },
    });
    FocusOverlay.create(deps);
    const overlay = getOverlay();
    expect(overlay.card.classList.contains('warn')).toBe(false);
    vi.advanceTimersByTime(21 * 1000);
    expect(overlay.card.classList.contains('warn')).toBe(true);
  });

  it('removes the overlay when the session is no longer active', () => {
    const deps = makeDeps({
      runtime: { sessions: { g1: {} } },
      response: { active: true, endsAt: NOW + 30 * 1000, domain: 'reddit.com', groupId: 'g1' },
    });
    const api = FocusOverlay.create(deps);
    expect(getOverlay()).not.toBeNull();
    api.handleResponse({ active: false });
    expect(document.getElementById('focus-guard-overlay-host')).toBeNull();
  });

  it('ends the session from the overlay button', () => {
    const navigate = vi.fn();
    const deps = makeDeps({
      runtime: { sessions: { g1: {} } },
      response: { active: true, endsAt: NOW + 30 * 1000, domain: 'reddit.com', groupId: 'g1' },
      navigate,
    });
    FocusOverlay.create(deps);
    const overlay = getOverlay();
    overlay.card.querySelector('.end').click();
    expect(deps.chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { type: 'session:end', groupId: 'g1' },
      expect.any(Function),
    );
    expect(navigate).toHaveBeenCalledWith(
      `chrome-extension://abc/blocked.html#${encodeURIComponent(TARGET)}`,
    );
  });

  it('re-checks when runtime storage changes', () => {
    const deps = makeDeps({
      runtime: { sessions: { g1: {} } },
      response: { active: true, endsAt: NOW + 30 * 1000, domain: 'reddit.com', groupId: 'g1' },
    });
    FocusOverlay.create(deps);
    const listener = deps.chrome.storage.onChanged.addListener.mock.calls[0][0];
    listener({ focusRuntime: { newValue: { sessions: { g1: {} } } } }, 'local');
    expect(deps.chrome.runtime.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    listener({ otherKey: {} }, 'local');
    expect(deps.chrome.runtime.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
