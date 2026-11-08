import { isWithinSchedule, scheduleBlockingEnd, nextScheduleChange, DAY_LABELS } from '../../lib/schedule.js';
import { isOverrideActive } from '../../lib/sessions.js';
import { isBlockingActive } from '../../lib/decision.js';
import { formatDuration, formatClockTime } from '../../lib/format.js';
import { randomQuoteIndex, QUOTES } from '../../lib/quotes.js';
import { REFLECTION_SECONDS } from '../../lib/constants.js';

export function computeStatus(config, runtime, now) {
  const date = new Date(now);
  const inSchedule = isWithinSchedule(date, config.schedule);
  const overrideActive = isOverrideActive(runtime, now);
  const blockingActive = isBlockingActive(now, config, runtime);
  const windowEnd = inSchedule ? scheduleBlockingEnd(date, config.schedule) : null;
  const nextChange = nextScheduleChange(date, config.schedule);
  const groups = (config && config.groups) || [];
  const activeSessions = Object.entries((runtime && runtime.sessions) || {})
    .filter(([, session]) => session.endsAt > now)
    .map(([groupId, session]) => {
      const group = groups.find((g) => g.id === groupId);
      return {
        groupId,
        domain: group ? group.domain : groupId,
        level: group ? group.level : null,
        endsAt: session.endsAt,
        minutes: session.minutes,
        remainingMs: session.endsAt - now,
      };
    });
  const cooldowns = Object.entries((runtime && runtime.cooldowns) || {})
    .filter(([, cooldown]) => cooldown.until > now)
    .map(([groupId, cooldown]) => {
      const group = groups.find((g) => g.id === groupId);
      return {
        groupId,
        domain: group ? group.domain : groupId,
        level: group ? group.level : null,
        until: cooldown.until,
        remainingMs: cooldown.until - now,
      };
    });
  return {
    inSchedule,
    overrideActive,
    overrideUntil: overrideActive && runtime.override ? runtime.override.until : null,
    blockingActive,
    masterEnabled: Boolean(config.master && config.master.enabled),
    windowEnd,
    nextChange,
    activeSessions,
    cooldowns,
  };
}

export function statusSummary(status) {
  if (!status.blockingActive) {
    if (status.inSchedule && status.overrideActive) {
      return {
        title: 'Blocking is paused',
        subtitle: status.overrideUntil
          ? `Inside your focus window. It turns back on at ${formatClockTime(new Date(status.overrideUntil))}.`
          : 'Inside your focus window. It turns back on when this window ends.',
      };
    }
    return {
      title: 'Blocking is off',
      subtitle: 'Outside your focus hours. Flip the switch to lock in a focus session anytime.',
    };
  }
  if (status.inSchedule) {
    return {
      title: 'Focus mode is on',
      subtitle: status.windowEnd
        ? `Scheduled focus window — blocking until ${formatClockTime(status.windowEnd)}.`
        : 'Scheduled focus window active.',
    };
  }
  return {
    title: 'Focus mode is on',
    subtitle: 'Manually enabled outside your schedule. Turn it off freely when you are done.',
  };
}

export function createReflectionModal(deps) {
  const {
    document,
    onConfirm,
    onCancel,
    seconds = REFLECTION_SECONDS,
    quoteRotateMs = 5000,
    setInterval: setInt = setInterval,
    clearInterval: clearInt = clearInterval,
  } = deps;

  let remaining = seconds;
  let closed = false;
  let lastQuoteIndex = -1;
  let tickTimer = null;
  let quoteTimer = null;

  const overlay = document.createElement('div');
  overlay.className = 'reflection-overlay';
  overlay.innerHTML = `
    <div class="reflection-card" role="dialog" aria-modal="true">
      <p class="reflection-eyebrow">Think it over</p>
      <h2 class="reflection-headline">Turn off focus blocking?</h2>
      <p class="reflection-sub">You are inside your focus window. This is the moment your future self is watching.</p>
      <div class="reflection-countdown" data-ref="countdown"></div>
      <p class="reflection-hint" data-ref="hint">You can confirm in a moment. Meanwhile…</p>
      <blockquote class="reflection-quote" data-ref="quote"></blockquote>
      <p class="reflection-author" data-ref="author"></p>
      <div class="reflection-actions">
        <button class="btn btn-primary" data-ref="confirm" disabled>Keep it off</button>
        <button class="btn" data-ref="cancel">Cancel — I'll stay focused</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const countdownEl = overlay.querySelector('[data-ref="countdown"]');
  const hintEl = overlay.querySelector('[data-ref="hint"]');
  const quoteEl = overlay.querySelector('[data-ref="quote"]');
  const authorEl = overlay.querySelector('[data-ref="author"]');
  const confirmBtn = overlay.querySelector('[data-ref="confirm"]');
  const cancelBtn = overlay.querySelector('[data-ref="cancel"]');

  function setQuote() {
    lastQuoteIndex = randomQuoteIndex(lastQuoteIndex);
    const quote = QUOTES[lastQuoteIndex];
    if (quote) {
      quoteEl.textContent = `“${quote.text}”`;
      authorEl.textContent = quote.author;
    }
  }

  function update() {
    if (remaining <= 0) {
      remaining = 0;
      countdownEl.textContent = 'Ready';
      hintEl.textContent = 'Still sure? The choice is yours.';
      confirmBtn.disabled = false;
      return;
    }
    countdownEl.textContent = formatDuration(remaining * 1000);
  }

  function destroy() {
    if (closed) return;
    closed = true;
    if (tickTimer) clearInt(tickTimer);
    if (quoteTimer) clearInt(quoteTimer);
    overlay.remove();
  }

  tickTimer = setInt(() => {
    remaining -= 1;
    update();
  }, 1000);
  quoteTimer = setInt(setQuote, quoteRotateMs);

  confirmBtn.addEventListener('click', () => {
    if (remaining > 0) return;
    destroy();
    if (onConfirm) onConfirm();
  });
  cancelBtn.addEventListener('click', () => {
    destroy();
    if (onCancel) onCancel();
  });

  setQuote();
  update();

  return { destroy };
}

export function collectGroupsFromDom(cards, makeId) {
  const groups = [];
  for (const card of cards) {
    const domainInput = card.querySelector('.group-domain');
    const levelPill = card.querySelector('.level-pill.on');
    const includeBase = card.querySelector('.group-include-base');
    const includeSubdomains = card.querySelector('.group-include-subdomains');
    const subdomains = [...card.querySelectorAll('[data-kind="subdomain"]')].map((el) => el.dataset.value);
    const whitelist = [...card.querySelectorAll('[data-kind="whitelist"]')].map((el) => el.dataset.value);
    groups.push({
      id: card.dataset.groupId || makeId(),
      domain: domainInput ? domainInput.value : '',
      includeBaseHost: includeBase ? includeBase.checked : false,
      includeAllSubdomains: includeSubdomains ? includeSubdomains.checked : false,
      subdomains,
      whitelist,
      level: levelPill && levelPill.dataset.level === 'total' ? 'total' : 'partial',
    });
  }
  return groups;
}

export function collectScheduleFromDom(rows) {
  const windows = [];
  const errors = [];
  for (const row of rows) {
    const day = Number(row.dataset.day);
    if (!Number.isInteger(day) || day < 0 || day > 6) continue;
    const ranges = row.querySelectorAll('.schedule-range');
    ranges.forEach((range, index) => {
      const start = range.querySelector('.range-start') ? range.querySelector('.range-start').value : '';
      const end = range.querySelector('.range-end') ? range.querySelector('.range-end').value : '';
      if (!start || !end) {
        errors.push({ day, index, message: `${DAY_LABELS[day]} range ${index + 1} needs both start and end times` });
        return;
      }
      if (start === end) {
        errors.push({ day, index, message: `${DAY_LABELS[day]} range ${index + 1} starts and ends at the same time` });
        return;
      }
      windows.push({ days: [day], start, end });
    });
  }
  return { windows, errors };
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
