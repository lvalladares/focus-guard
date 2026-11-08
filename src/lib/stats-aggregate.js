const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au',
  'co.nz', 'net.nz', 'org.nz',
  'com.br', 'com.mx', 'com.ar',
  'co.jp', 'ne.jp', 'or.jp',
  'co.kr', 'or.kr',
  'com.tr', 'com.cn', 'net.cn', 'org.cn',
  'co.za', 'com.sg', 'com.hk', 'com.tw',
]);

export function registrableDomain(hostname) {
  if (typeof hostname !== 'string' || hostname.length === 0) return '';
  const labels = hostname.split('.');
  if (labels.length <= 2) return hostname;
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo)) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

function matchesQuery(hostname, query) {
  if (!query) return true;
  return hostname.toLowerCase().includes(query.toLowerCase());
}

export function aggregateStats(buckets, { query = '' } = {}) {
  const hosts = new Map();
  for (const dayData of Object.values(buckets || {})) {
    for (const [hostname, entry] of Object.entries(dayData || {})) {
      const seconds = Number(entry && entry.s) || 0;
      const visits = Number(entry && entry.v) || 0;
      const existing = hosts.get(hostname) || { hostname, seconds: 0, visits: 0 };
      existing.seconds += seconds;
      existing.visits += visits;
      hosts.set(hostname, existing);
    }
  }

  const allHosts = [...hosts.values()].sort((a, b) => b.seconds - a.seconds || a.hostname.localeCompare(b.hostname));
  const filteredHosts = query ? allHosts.filter((h) => matchesQuery(h.hostname, query)) : allHosts;

  const domainMap = new Map();
  for (const host of filteredHosts) {
    const domain = registrableDomain(host.hostname);
    let entry = domainMap.get(domain);
    if (!entry) {
      entry = { domain, seconds: 0, visits: 0, hosts: [] };
      domainMap.set(domain, entry);
    }
    entry.seconds += host.seconds;
    entry.visits += host.visits;
    entry.hosts.push(host);
  }

  const totalSeconds = filteredHosts.reduce((sum, h) => sum + h.seconds, 0);
  const totalVisits = filteredHosts.reduce((sum, h) => sum + h.visits, 0);

  const domains = [...domainMap.values()].sort((a, b) => b.seconds - a.seconds || a.domain.localeCompare(b.domain));
  const topSeconds = domains.length > 0 ? domains[0].seconds : 0;

  return {
    totalSeconds,
    totalVisits,
    siteCount: filteredHosts.length,
    hosts: filteredHosts,
    domains: domains.map((d) => ({
      ...d,
      hosts: [...d.hosts].sort((a, b) => b.seconds - a.seconds || a.hostname.localeCompare(b.hostname)),
      sharePct: totalSeconds > 0 ? Math.round((d.seconds / totalSeconds) * 100) : 0,
      barPct: topSeconds > 0 ? Math.max(2, Math.round((d.seconds / topSeconds) * 100)) : 0,
    })),
  };
}
