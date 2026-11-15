import { isScheduleActive, scheduleBlockingEnd, nextBlocksScheduleChange, DAY_LABELS } from '../../lib/schedule.js';
import { isOverrideActive, deriveBlockRuntime } from '../../lib/sessions.js';
import { isBlockActive, isBlockingActive, isAntiUninstallActive } from '../../lib/decision.js';
import { isBlockLocked } from '../../lib/config.js';
import { formatDuration, formatClockTime } from '../../lib/format.js';
import { randomQuoteIndex, QUOTES } from '../../lib/quotes.js';
import { REFLECTION_SECONDS } from '../../lib/constants.js';

export function computeStatus(config, runtime, now, blockStates = {}) {
  const date = new Date(now);
  const blocks = (config && Array.isArray(config.blocks)) ? config.blocks : [];

  const activeBlocks = blocks.filter((b) => isBlockActive(b, now, config, runtime));
  const lockedBlocks = blocks.filter((b) => isBlockLocked(b, now));
  const scheduledBlocks = blocks.filter((b) => b.enabled && isScheduleActive(date, b.schedule));
  const hasNonPersistentScheduled = scheduledBlocks.some((b) => !b.persistent);
  const inSchedule = scheduledBlocks.length > 0;
  const overrideActive = isOverrideActive(runtime, now);
  const blockingActive = isBlockingActive(now, config, runtime);
  const nextChange = nextBlocksScheduleChange(date, blocks);

  const activeSnoozes = [];
  const activeBudgets = [];
  for (const block of activeBlocks) {
    const rt = deriveBlockRuntime(block, blockStates ? blockStates[block.id] : null, now);
    if (rt.state === 'snooze') {
      activeSnoozes.push({
        blockId: block.id,
        blockName: block.name,
        endsAt: rt.snooze.endsAt,
        durationMinutes: rt.snooze.durationMinutes,
        remainingMs: rt.remainingMs,
      });
    } else if (rt.state === 'budget') {
      activeBudgets.push({
        blockId: block.id,
        blockName: block.name,
        remainingMs: rt.budgetRemainingMs,
        limitMs: rt.limitMs,
        resetAt: rt.budgetResetAt,
      });
    }
  }

  let earliestWindowEnd = null;
  for (const b of scheduledBlocks) {
    const end = scheduleBlockingEnd(date, b.schedule);
    if (end && (!earliestWindowEnd || end.getTime() < earliestWindowEnd.getTime())) {
      earliestWindowEnd = end;
    }
  }

  return {
    inSchedule,
    hasNonPersistentScheduled,
    hasLockedBlock: lockedBlocks.length > 0,
    lockedBlockCount: lockedBlocks.length,
    activeBlockCount: activeBlocks.length,
    antiUninstallEnabled: Boolean(config && config.antiUninstall && config.antiUninstall.enabled),
    antiUninstallActive: isAntiUninstallActive(config, now),
    overrideActive,
    overrideUntil: overrideActive && runtime.override ? runtime.override.until : null,
    blockingActive,
    masterEnabled: Boolean(config && config.master && config.master.enabled),
    windowEnd: earliestWindowEnd,
    nextChange,
    activeSnoozes,
    activeBudgets,
  };
}

export function statusSummary(status) {
  if (!status.blockingActive) {
    if (status.inSchedule && status.overrideActive) {
      return {
        title: 'Blocking is paused',
        subtitle: status.overrideUntil
          ? `Non-persistent scheduled blocks are paused until ${formatClockTime(new Date(status.overrideUntil))}.`
          : 'Non-persistent scheduled blocks are paused until their window ends.',
      };
    }
    return {
      title: 'Blocking is off',
      subtitle: 'No focus block is currently active. Flip the switch to turn on enabled blocks anytime.',
    };
  }
  if (status.hasLockedBlock) {
    return {
      title: 'Focus mode is locked on',
      subtitle: `${status.lockedBlockCount} persistent ${status.lockedBlockCount === 1 ? 'block is' : 'blocks are'} active and cannot be edited or disabled during scheduled hours.`,
    };
  }
  if (status.inSchedule) {
    return {
      title: 'Focus mode is on',
      subtitle: status.windowEnd
        ? `Scheduled focus blocks active (next end at ${formatClockTime(status.windowEnd)}).`
        : 'Scheduled focus blocks are active.',
    };
  }
  return {
    title: 'Focus mode is on',
    subtitle: 'Manually enabled outside block schedules. Turn it off freely when you are done.',
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
      <h2 class="reflection-headline">Pause non-persistent blocks?</h2>
      <p class="reflection-sub">You are inside a scheduled focus window. Persistent blocks will remain locked and active.</p>
      <div class="reflection-countdown" data-ref="countdown"></div>
      <p class="reflection-hint" data-ref="hint">You can confirm in a moment. Meanwhile…</p>
      <blockquote class="reflection-quote" data-ref="quote"></blockquote>
      <p class="reflection-author" data-ref="author"></p>
      <div class="reflection-actions">
        <button class="btn btn-primary" data-ref="confirm" disabled>Pause non-persistent blocks</button>
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

export function collectSitesFromCard(card, makeSiteId) {
  const sites = [];
  for (const row of card.querySelectorAll('.site-card')) {
    const domainInput = row.querySelector('.site-domain');
    const includeBase = row.querySelector('.site-include-base');
    const includeSubdomains = row.querySelector('.site-include-subdomains');
    const subdomains = [...row.querySelectorAll('[data-kind="subdomain"]')].map((el) => el.dataset.value);
    const whitelist = [...row.querySelectorAll('[data-kind="whitelist"]')].map((el) => el.dataset.value);
    sites.push({
      id: row.dataset.siteId || makeSiteId(),
      domain: domainInput ? domainInput.value : '',
      includeBaseHost: includeBase ? includeBase.checked : false,
      includeAllSubdomains: includeSubdomains ? includeSubdomains.checked : false,
      subdomains,
      whitelist,
    });
  }
  return sites;
}

export function collectBlockScheduleFromCard(card, blockName) {
  const alwaysActiveInput = card.querySelector('.block-always-active');
  const alwaysActive = Boolean(alwaysActiveInput && alwaysActiveInput.checked);
  const windows = [];
  const errors = [];
  const rows = card.querySelectorAll('.window-row');
  rows.forEach((row, index) => {
    const days = [...row.querySelectorAll('.day-pill.on')]
      .map((btn) => Number(btn.dataset.day))
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    const start = row.querySelector('.range-start') ? row.querySelector('.range-start').value : '';
    const end = row.querySelector('.range-end') ? row.querySelector('.range-end').value : '';
    if (days.length === 0) {
      errors.push({ blockName, index, message: `${blockName} window ${index + 1}: select at least one day` });
      return;
    }
    if (!start || !end) {
      errors.push({ blockName, index, message: `${blockName} window ${index + 1}: needs both start and end times` });
      return;
    }
    if (start === end) {
      errors.push({ blockName, index, message: `${blockName} window ${index + 1}: start and end cannot be the same` });
      return;
    }
    windows.push({ days, start, end });
  });
  return { schedule: { alwaysActive, windows }, errors };
}

export function collectBlocksFromDom(cards, { makeBlockId, makeSiteId }) {
  const blocks = [];
  const scheduleErrors = [];
  for (const card of cards) {
    const nameInput = card.querySelector('.block-name');
    const name = (nameInput ? nameInput.value.trim() : '') || 'Block';
    const enabledInput = card.querySelector('.block-enabled');
    const persistentInput = card.querySelector('.block-persistent');

    const sites = collectSitesFromCard(card, makeSiteId);
    const { schedule, errors } = collectBlockScheduleFromCard(card, name);
    scheduleErrors.push(...errors);

    const limitEnabled = card.querySelector('.limit-enabled');
    const limitMinutes = card.querySelector('.limit-minutes');
    const limitHours = card.querySelector('.limit-hours');

    const snoozeEnabled = card.querySelector('.snooze-enabled');
    const snoozeDuration = card.querySelector('.snooze-duration');
    const snoozeMax = card.querySelector('.snooze-max');
    const snoozeHours = card.querySelector('.snooze-hours');

    blocks.push({
      id: card.dataset.blockId || makeBlockId(),
      name,
      enabled: enabledInput ? enabledInput.checked : true,
      persistent: persistentInput ? persistentInput.checked : false,
      sites,
      schedule,
      timeLimit: {
        enabled: limitEnabled ? limitEnabled.checked : false,
        minutes: limitMinutes ? Number(limitMinutes.value) : 20,
        periodHours: limitHours ? Number(limitHours.value) : 8,
      },
      snooze: {
        enabled: snoozeEnabled ? snoozeEnabled.checked : false,
        durationMinutes: snoozeDuration ? Number(snoozeDuration.value) : 5,
        maxCount: snoozeMax ? Number(snoozeMax.value) : 1,
        periodHours: snoozeHours ? Number(snoozeHours.value) : 4,
      },
    });
  }
  return { blocks, scheduleErrors };
}

export { DAY_LABELS };

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
