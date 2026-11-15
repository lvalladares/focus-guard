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

function makeChrome({ response }) {
  return {
    storage: {
      onChanged: { addListener: vi.fn() },
    },
    runtime: {
      sendMessage: vi.fn((msg, cb) => cb(response)),
      lastError: null,
    },
  };
}

function makeDeps({ response = {}, navigate } = {}) {
  return {
    chrome: makeChrome({ response }),
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
  return {
    host,
    card: host.shadowRoot.querySelector('.card'),
    label: host.shadowRoot.querySelector('.label'),
    time: host.shadowRoot.querySelector('.time'),
    domain: host.shadowRoot.querySelector('.domain'),
    endBtn: host.shadowRoot.querySelector('.end'),
  };
}

describe('focus overlay', () => {
  it('stays unmounted when overlay:check reports inactive', () => {
    const deps = makeDeps({ response: { active: false } });
    FocusOverlay.create(deps);
    expect(deps.chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { type: 'overlay:check', url: TARGET },
      expect.any(Function),
    );
    expect(document.getElementById('focus-guard-overlay-host')).toBeNull();
  });

  it('shows a Snooze countdown when less than a minute remains', () => {
    const response = { active: true, mode: 'snooze', endsAt: NOW + 30 * 1000, blockName: 'Social', blockId: 'b1' };
    const deps = makeDeps({ response });
    FocusOverlay.create(deps);
    const overlay = getOverlay();
    expect(overlay).not.toBeNull();
    expect(overlay.host.style.display).not.toBe('none');
    expect(overlay.label.textContent).toBe('Snooze');
    expect(overlay.time.textContent).toBe('0:30');
    expect(overlay.domain.textContent).toBe('Social');
    expect(overlay.endBtn.classList.contains('hidden')).toBe(false);
  });

  it('shows a Time limit label and hides the end-snooze button in budget mode', () => {
    const response = { active: true, mode: 'budget', endsAt: NOW + 45 * 1000, blockName: 'Social', blockId: 'b1' };
    const deps = makeDeps({ response });
    FocusOverlay.create(deps);
    const overlay = getOverlay();
    expect(overlay.label.textContent).toBe('Time limit');
    expect(overlay.endBtn.classList.contains('hidden')).toBe(true);
  });

  it('ticks the countdown down and redirects when snooze time is up', () => {
    const navigate = vi.fn();
    const deps = makeDeps({
      response: { active: true, mode: 'snooze', endsAt: NOW + 30 * 1000, blockName: 'Social', blockId: 'b1' },
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
      response: { active: true, mode: 'snooze', endsAt: NOW + 5 * 60 * 1000, blockName: 'Social', blockId: 'b1' },
    });
    FocusOverlay.create(deps);
    const overlay = getOverlay();
    expect(overlay).not.toBeNull();
    expect(overlay.host.style.display).toBe('none');
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(overlay.host.style.display).not.toBe('none');
    expect(overlay.time.textContent).toBe('1:00');
  });

  it('warns with a highlighted countdown in the last 10 seconds', () => {
    const deps = makeDeps({
      response: { active: true, mode: 'snooze', endsAt: NOW + 30 * 1000, blockName: 'Social', blockId: 'b1' },
    });
    FocusOverlay.create(deps);
    const overlay = getOverlay();
    expect(overlay.card.classList.contains('warn')).toBe(false);
    vi.advanceTimersByTime(21 * 1000);
    expect(overlay.card.classList.contains('warn')).toBe(true);
  });

  it('removes the overlay when no longer active', () => {
    const deps = makeDeps({
      response: { active: true, mode: 'snooze', endsAt: NOW + 30 * 1000, blockName: 'Social', blockId: 'b1' },
    });
    const api = FocusOverlay.create(deps);
    expect(getOverlay()).not.toBeNull();
    api.handleResponse({ active: false });
    expect(document.getElementById('focus-guard-overlay-host')).toBeNull();
  });

  it('ends snooze from the overlay button', () => {
    const navigate = vi.fn();
    const deps = makeDeps({
      response: { active: true, mode: 'snooze', endsAt: NOW + 30 * 1000, blockName: 'Social', blockId: 'b1' },
      navigate,
    });
    FocusOverlay.create(deps);
    getOverlay().endBtn.click();
    expect(deps.chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { type: 'snooze:end', blockId: 'b1' },
      expect.any(Function),
    );
    expect(navigate).toHaveBeenCalledWith(
      `chrome-extension://abc/blocked.html#${encodeURIComponent(TARGET)}`,
    );
  });

  it('re-checks when sync or runtime storage changes', () => {
    const deps = makeDeps({ response: { active: false } });
    FocusOverlay.create(deps);
    const listener = deps.chrome.storage.onChanged.addListener.mock.calls[0][0];
    listener({ 'focusBlockState:b1': { newValue: {} } }, 'sync');
    expect(deps.chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
    listener({ focusRuntime: { newValue: {} } }, 'local');
    expect(deps.chrome.runtime.sendMessage).toHaveBeenCalledTimes(3);
    listener({ unrelated: {} }, 'sync');
    expect(deps.chrome.runtime.sendMessage).toHaveBeenCalledTimes(3);
  });
});
