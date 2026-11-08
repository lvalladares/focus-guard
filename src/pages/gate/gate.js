import { evaluate } from '../../lib/decision.js';
import { parseHashTarget } from '../../lib/url.js';
import { isWithinSchedule, scheduleBlockingEnd } from '../../lib/schedule.js';
import { formatClockTime } from '../../lib/format.js';
import { randomQuoteIndex, QUOTES } from '../../lib/quotes.js';
import { defaultConfig } from '../../lib/config.js';
import { FREE_TIME_OPTIONS, STORAGE_KEYS } from '../../lib/constants.js';

export function createGateController(deps) {
  const {
    document,
    location,
    storage,
    now,
    navigate,
    historyBack,
    sendMessage,
    blockedUrlOf,
    wallpaperFor,
  } = deps;

  const els = {
    wallpaper: document.getElementById('wallpaper-img'),
    detail: document.getElementById('detail'),
    warning: document.getElementById('warning'),
    quote: document.getElementById('quote'),
    quoteAuthor: document.getElementById('quote-author'),
    dismiss: document.getElementById('btn-dismiss'),
    doses: [...document.querySelectorAll('.dose')],
  };

  let state = { config: defaultConfig(), runtime: { sessions: {}, cooldowns: {}, override: null } };
  let target = null;
  let lastQuoteIndex = -1;

  function renderQuote() {
    lastQuoteIndex = randomQuoteIndex(lastQuoteIndex);
    const quote = QUOTES[lastQuoteIndex];
    if (quote) {
      els.quote.textContent = `“${quote.text}”`;
      els.quoteAuthor.textContent = quote.author;
    }
  }

  async function refresh() {
    const store = await storage.get([STORAGE_KEYS.CONFIG, STORAGE_KEYS.RUNTIME]);
    const config = store[STORAGE_KEYS.CONFIG] || defaultConfig();
    const runtime = store[STORAGE_KEYS.RUNTIME] || { sessions: {}, cooldowns: {}, override: null };
    state = { config, runtime };
    render();
  }

  function render() {
    renderQuote();
    els.wallpaper.src = wallpaperFor(state.config);
    target = parseHashTarget(location.hash);

    if (!target) {
      els.detail.textContent = 'You opened the Focus Guard gate directly. Nothing to unlock here.';
      setDosesEnabled(false);
      return;
    }

    const result = evaluate({ url: target, now: now(), config: state.config, runtime: state.runtime });
    const domain = result.group ? result.group.domain : '';

    if (result.verdict !== 'gate') {
      if (result.verdict === 'allow') navigate(target);
      else navigate(blockedUrlOf(target));
      return;
    }

    const end = scheduleBlockingEnd(new Date(now()), state.config.schedule);
    const hint = end && isWithinSchedule(new Date(now()), state.config.schedule)
      ? ` Your focus window ends at <strong>${formatClockTime(end)}</strong>.`
      : '';
    els.detail.innerHTML = `<strong>${domain}</strong> is partially blocked. Pick your dose, spend it well, and it will close by itself.${hint}`;
    setDosesEnabled(true);
  }

  function setDosesEnabled(enabled) {
    for (const dose of els.doses) {
      dose.disabled = !enabled;
      dose.classList.toggle('disabled', !enabled);
    }
  }

  async function chooseDose(minutes) {
    if (!target) return;
    setDosesEnabled(false);
    els.warning.textContent = '';
    try {
      const response = await sendMessage({ type: 'session:start', groupId: currentGroupId(), minutes, targetUrl: target });
      if (response && response.ok) {
        navigate(target);
        return;
      }
      if (response && response.verdict === 'allow') {
        navigate(target);
        return;
      }
      if (response && response.verdict) {
        navigate(blockedUrlOf(target));
        return;
      }
      els.warning.textContent = response && response.error ? response.error : 'Could not start the session. Try again.';
      setDosesEnabled(true);
    } catch {
      els.warning.textContent = 'Could not start the session. Try again.';
      setDosesEnabled(true);
    }
  }

  function currentGroupId() {
    if (!target) return null;
    const result = evaluate({ url: target, now: now(), config: state.config, runtime: state.runtime });
    return result.group ? result.group.id : null;
  }

  for (const dose of els.doses) {
    dose.addEventListener('click', () => {
      const minutes = Number(dose.dataset.minutes);
      if (FREE_TIME_OPTIONS.includes(minutes)) chooseDose(minutes);
    });
  }
  els.dismiss.addEventListener('click', () => historyBack());

  const api = { refresh, chooseDose };

  refresh();

  return api;
}
