import { evaluate } from './decision.js';
import { parseHashTarget } from './url.js';

function actionable(tab) {
  return Boolean(tab) && tab.id !== undefined && typeof tab.url === 'string' && tab.url !== '';
}

function isBlockingVerdict(verdict) {
  return verdict === 'block' || verdict === 'block-snoozable' || verdict === 'block-anti-uninstall';
}

export function planSweep(tabs, { config, runtime, blockStates = {}, now, redirectFor }) {
  const actions = [];
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    if (!actionable(tab)) continue;
    const result = evaluate({ url: tab.url, now, config, runtime, blockStates });
    if (!isBlockingVerdict(result.verdict)) continue;
    const destination = redirectFor(tab.url, result.verdict);
    if (destination && destination !== tab.url) actions.push({ tabId: tab.id, url: destination });
  }
  return actions;
}

export function targetOfBlockedPage(pageUrl, { blockedPageUrl, gatePageUrl }) {
  if (typeof pageUrl !== 'string') return null;
  let raw = null;
  if (blockedPageUrl && pageUrl.startsWith(blockedPageUrl)) raw = pageUrl.slice(blockedPageUrl.length);
  else if (gatePageUrl && pageUrl.startsWith(gatePageUrl)) raw = pageUrl.slice(gatePageUrl.length);
  else return null;
  return parseHashTarget(raw);
}

export function planRestore(tabs, { config, runtime, blockStates = {}, now, blockedPageUrl, gatePageUrl }) {
  const actions = [];
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    if (!actionable(tab)) continue;
    const target = targetOfBlockedPage(tab.url, { blockedPageUrl, gatePageUrl });
    if (!target) continue;
    const result = evaluate({ url: target, now, config, runtime, blockStates });
    if (result.verdict !== 'allow') continue;
    actions.push({ tabId: tab.id, url: target });
  }
  return actions;
}
