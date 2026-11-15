import { matchSiteInBlock } from './patterns.js';
import { isScheduleActive, scheduleBlockingEnd } from './schedule.js';
import { isOverrideActive, deriveBlockRuntime } from './sessions.js';
import { hasActivePersistentBlock } from './config.js';
import { safeParseUrl } from './url.js';

export function isBlockActive(block, nowMs, config, runtime) {
  if (!block || !block.enabled) return false;
  const inSchedule = isScheduleActive(new Date(nowMs), block.schedule);
  if (inSchedule) {
    if (block.persistent) return true;
    return !isOverrideActive(runtime, nowMs);
  }
  return Boolean(config && config.master && config.master.enabled);
}

export function isBlockingActive(nowMs, config, runtime) {
  if (!config || !Array.isArray(config.blocks)) return false;
  return config.blocks.some((block) => isBlockActive(block, nowMs, config, runtime));
}

export function isAntiUninstallActive(config, nowMs) {
  return Boolean(config && config.antiUninstall && config.antiUninstall.enabled)
    && hasActivePersistentBlock(config, nowMs);
}

const EXTENSION_MGMT_PREFIXES = [
  'chrome://extensions',
  'edge://extensions',
  'brave://extensions',
  'opera://extensions',
  'vivaldi://extensions',
  'chrome://settings/extensions',
];

export function isExtensionsManagementUrl(url) {
  if (typeof url !== 'string') return false;
  const lower = url.trim().toLowerCase();
  return EXTENSION_MGMT_PREFIXES.some((prefix) => (
    lower === prefix
    || lower.startsWith(`${prefix}/`)
    || lower.startsWith(`${prefix}?`)
    || lower.startsWith(`${prefix}#`)
  ));
}

function allow(extra = {}) {
  return {
    verdict: 'allow',
    blockingActive: false,
    whitelisted: false,
    primaryBlock: null,
    activeTimer: null,
    budgetBlocks: [],
    blockingBlocks: [],
    snoozableBlocks: [],
    nextUnlockAt: null,
    blockEndAt: null,
    reason: null,
    ...extra,
  };
}

function earliestBlockUnlock(rt) {
  const candidates = [];
  if (rt.nextSnoozeAt) candidates.push(rt.nextSnoozeAt);
  if (rt.budgetResetAt) candidates.push(rt.budgetResetAt);
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

function earliestWindowEnd(evaluations, now) {
  let best = null;
  for (const { block } of evaluations) {
    const end = scheduleBlockingEnd(new Date(now), block.schedule);
    if (!end) continue;
    if (!best || end.getTime() < best.getTime()) best = end;
  }
  return best;
}

export function evaluate({ url, now, config, runtime, blockStates = {} }) {
  if (isExtensionsManagementUrl(url)) {
    if (isAntiUninstallActive(config, now)) {
      return {
        ...allow(),
        verdict: 'block-anti-uninstall',
        blockingActive: true,
        reason: 'anti-uninstall',
      };
    }
    return allow();
  }

  const parsed = safeParseUrl(url);
  if (!parsed) return allow();
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return allow();

  const blocks = (config && Array.isArray(config.blocks)) ? config.blocks : [];
  let anyWhitelisted = false;
  const activeEvaluations = [];

  for (const block of blocks) {
    const match = matchSiteInBlock(url, block);
    if (!match) continue;
    if (match.whitelisted) {
      anyWhitelisted = true;
      continue;
    }
    if (!isBlockActive(block, now, config, runtime)) continue;
    const rt = deriveBlockRuntime(block, blockStates ? blockStates[block.id] : null, now);
    activeEvaluations.push({ block, match, rt });
  }

  if (activeEvaluations.length === 0) {
    return allow({ whitelisted: anyWhitelisted });
  }

  const hardBlocking = activeEvaluations.filter(
    (e) => e.rt.state === 'blocked' || e.rt.state === 'snoozes-exhausted',
  );
  const snoozable = activeEvaluations.filter((e) => e.rt.state === 'snoozable');
  const allowing = activeEvaluations.filter((e) => e.rt.state === 'snooze' || e.rt.state === 'budget');

  if (hardBlocking.length > 0) {
    const allHaveUnlock = hardBlocking.every((e) => earliestBlockUnlock(e.rt) !== null);
    const nextUnlockAt = allHaveUnlock
      ? Math.max(...hardBlocking.map((e) => earliestBlockUnlock(e.rt)))
      : null;
    const primary = hardBlocking[0];
    const reason = primary.rt.state === 'snoozes-exhausted'
      ? 'snoozes-exhausted'
      : (primary.rt.budgetResetAt ? 'budget-exhausted' : 'hard-block');
    return {
      ...allow(),
      verdict: 'block',
      blockingActive: true,
      primaryBlock: primary.block,
      blockingBlocks: [...hardBlocking, ...snoozable],
      snoozableBlocks: [],
      nextUnlockAt,
      blockEndAt: earliestWindowEnd(hardBlocking, now),
      reason,
      primaryRuntime: primary.rt,
    };
  }

  if (snoozable.length > 0) {
    const primary = snoozable[0];
    return {
      ...allow(),
      verdict: 'block-snoozable',
      blockingActive: true,
      primaryBlock: primary.block,
      blockingBlocks: snoozable,
      snoozableBlocks: snoozable,
      nextUnlockAt: primary.rt.budgetResetAt || null,
      blockEndAt: earliestWindowEnd(snoozable, now),
      reason: primary.rt.budgetResetAt ? 'budget-exhausted' : 'snoozable',
      primaryRuntime: primary.rt,
    };
  }

  let shortest = allowing[0];
  for (const item of allowing) {
    if (item.rt.remainingMs < shortest.rt.remainingMs) shortest = item;
  }
  const budgetBlocks = allowing
    .filter((e) => e.rt.state === 'budget')
    .map((e) => e.block);

  return allow({
    blockingActive: true,
    primaryBlock: shortest.block,
    activeTimer: {
      mode: shortest.rt.state,
      blockId: shortest.block.id,
      blockName: shortest.block.name,
      remainingMs: shortest.rt.remainingMs,
      endsAt: now + shortest.rt.remainingMs,
    },
    budgetBlocks,
  });
}
