import { evaluate } from './decision.js';
import { parseHashTarget } from './url.js';

// A tab we can act on: known id and known URL.
function actionable(tab) {
  return Boolean(tab) && tab.id !== undefined && typeof tab.url === 'string' && tab.url !== '';
}

// Redirects for open tabs sitting on blocked sites, mirroring what the DNR rules do to
// fresh navigations: `block`/`cooldown` -> blocked page, `gate` -> gate page. Tabs whose
// verdict is `allow` (no group, whitelisted, dose running, blocking off) are left alone.
export function planSweep(tabs, { config, runtime, now, redirectFor }) {
  const actions = [];
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    if (!actionable(tab)) continue;
    const result = evaluate({ url: tab.url, now, config, runtime });
    if (result.verdict !== 'block' && result.verdict !== 'cooldown' && result.verdict !== 'gate') continue;
    const destination = redirectFor(tab.url, result.verdict);
    if (destination && destination !== tab.url) actions.push({ tabId: tab.id, url: destination });
  }
  return actions;
}

// The original URL a tab parked on the blocked/gate page is holding, if any.
export function targetOfBlockedPage(pageUrl, { blockedPageUrl, gatePageUrl }) {
  if (typeof pageUrl !== 'string') return null;
  let raw = null;
  if (pageUrl.startsWith(blockedPageUrl)) raw = pageUrl.slice(blockedPageUrl.length);
  else if (pageUrl.startsWith(gatePageUrl)) raw = pageUrl.slice(gatePageUrl.length);
  else return null;
  return parseHashTarget(raw);
}

// Sends tabs parked on the blocked/gate pages back to their target once that target is
// allowed again: blocking turned off, a dose running, a path whitelisted, a group removed.
// Gate pages are the exception: while a dose is running they navigate themselves right
// after `session:start` answers, so they are skipped to avoid racing that navigation.
export function planRestore(tabs, { config, runtime, now, blockedPageUrl, gatePageUrl }) {
  const actions = [];
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    if (!actionable(tab)) continue;
    const target = targetOfBlockedPage(tab.url, { blockedPageUrl, gatePageUrl });
    if (!target) continue;
    const result = evaluate({ url: target, now, config, runtime });
    if (result.verdict !== 'allow') continue;
    const onGatePage = tab.url.startsWith(gatePageUrl);
    if (onGatePage && result.session) continue;
    actions.push({ tabId: tab.id, url: target });
  }
  return actions;
}
