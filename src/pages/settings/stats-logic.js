import { aggregateStats } from '../../lib/stats-aggregate.js';

export function formatHours(seconds) {
  const total = Math.round(Number(seconds) || 0);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

export function isHostBlocked(hostname, config) {
  for (const group of (config && config.groups) || []) {
    if (group.includeBaseHost && hostname === group.domain) return true;
    if (group.includeAllSubdomains && hostname.endsWith(`.${group.domain}`)) return true;
    if ((group.subdomains || []).includes(hostname)) return true;
  }
  return false;
}

export function buildStatsModel(buckets, { query = '', config } = {}) {
  const agg = aggregateStats(buckets, { query });
  const domains = agg.domains.map((domain) => {
    const hosts = domain.hosts.map((h) => ({ ...h, blocked: isHostBlocked(h.hostname, config) }));
    const topHostSeconds = hosts.length > 0 ? hosts[0].seconds : 0;
    return {
      ...domain,
      blocked: hosts.some((h) => h.blocked),
      hosts: hosts.map((h) => ({
        ...h,
        barPct: topHostSeconds > 0 ? Math.max(2, Math.round((h.seconds / topHostSeconds) * 100)) : 0,
      })),
    };
  });
  return { ...agg, domains };
}

export function statsTableHtml(model) {
  if (!model || model.domains.length === 0) {
    return '<p class="muted small stats-empty">No tracked time in this period yet. Get browsing — productively.</p>';
  }
  const header = `
    <div class="stats-row stats-head">
      <span></span>
      <span class="col-host">Site</span>
      <span class="col-bar"></span>
      <span class="col-time">Time</span>
      <span class="col-share">Share</span>
      <span class="col-visits">Visits</span>
      <span class="col-action"></span>
    </div>`;

  const rows = model.domains.map((domain) => {
    const badge = domain.blocked ? ' <span class="badge">blocked</span>' : '';
    const children = domain.hosts.length > 1
      ? `
      <div class="stats-children${domain.expanded ? '' : ' hidden'}" data-children-of="${escapeAttr(domain.domain)}">
        ${domain.hosts.map((host) => `
          <div class="stats-row sub">
            <span></span>
            <span class="col-host">${escapeHtml(host.hostname)}${host.blocked ? ' <span class="badge">blocked</span>' : ''}</span>
            <span class="col-bar"><span class="bar"><span class="fill" style="width:${host.barPct}%"></span></span></span>
            <span class="col-time">${formatHours(host.seconds)}</span>
            <span class="col-share muted">—</span>
            <span class="col-visits">${host.visits}</span>
            <span class="col-action"></span>
          </div>`).join('')}
      </div>`
      : '';
    const expander = domain.hosts.length > 1
      ? `<button class="expander${domain.expanded ? ' open' : ''}" data-expand="${escapeAttr(domain.domain)}" type="button" title="Toggle subdomains">▸</button>`
      : '<span class="expander-spacer"></span>';
    return `
      <div class="stats-block" data-domain-block="${escapeAttr(domain.domain)}">
        <div class="stats-row domain">
          ${expander}
          <span class="col-host">${escapeHtml(domain.domain)}${badge}</span>
          <span class="col-bar"><span class="bar"><span class="fill" style="width:${domain.barPct}%"></span></span></span>
          <span class="col-time">${formatHours(domain.seconds)}</span>
          <span class="col-share">${domain.sharePct}%</span>
          <span class="col-visits">${domain.visits}</span>
          <span class="col-action"><button class="btn btn-small${domain.blocked ? ' btn-done' : ''}" data-block-domain="${escapeAttr(domain.domain)}" type="button">${domain.blocked ? 'Blocked' : 'Block'}</button></span>
        </div>
        ${children}
      </div>`;
  }).join('');

  return header + rows;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}
