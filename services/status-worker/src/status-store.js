export const HOUR = 3600000;
export const RETENTION = 31 * 24 * HOUR;
export const STATUS_KEY = 'status:v1';
export const HISTORY_KEY = 'history:v1';

export const latestSnapshot = (results, now) => ({
    services: results.map(({service, name, status, statusCode, latency, checkedAt}) => ({
        service, name, status, statusCode, latencyMs: latency, checkedAt
    })).sort((a, b) => a.name.localeCompare(b.name)),
    generatedAt: now
});

// Keep sums, so repeatedly updating an hour never compounds rounding errors.
export const appendHistory = (previous, results, now) => {
    const cutoff = Math.floor((now - RETENTION) / HOUR) * HOUR;
    const buckets = new Map((previous?.buckets || [])
        .filter(item => item.bucket >= cutoff)
        .map(item => [JSON.stringify([item.service, item.name, item.bucket]), {...item}]));
    for (const result of results) {
        const bucket = Math.floor(result.checkedAt / HOUR) * HOUR;
        const key = JSON.stringify([result.service, result.name, bucket]);
        const item = buckets.get(key) || {
            service: result.service, name: result.name, bucket,
            operational: 0, latencyTotal: 0, samples: 0
        };
        item.operational += Number(result.status === 'operational');
        item.latencyTotal += result.latency;
        item.samples++;
        buckets.set(key, item);
    }
    return {buckets: [...buckets.values()].sort((a, b) => a.bucket - b.bucket), generatedAt: now};
};

export const historyHours = request => {
    const value = Number(new URL(request.url).searchParams.get('hours'));
    return Math.min(720, Math.max(1, Math.floor(Number.isFinite(value) && value ? value : 168)));
};

export const publicBuckets = (snapshot, hours, now) => {
    // Include the boundary hour. Raw samples are no longer retained.
    const since = Math.floor((now - hours * HOUR) / HOUR) * HOUR;
    return snapshot.buckets.filter(item => item.bucket >= since).map(item => ({
        service: item.service, name: item.name, bucket: item.bucket,
        uptime: Math.round(item.operational / item.samples * 10000) / 100,
        latencyMs: Math.round(item.latencyTotal / item.samples), samples: item.samples
    }));
};
