function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function parseTargets(document) {
  if (!Array.isArray(document?.targets)) {
    throw new TypeError('Calibration corpus must contain a targets array.');
  }

  const origins = new Set();
  return document.targets.map((target, index) => {
    if (typeof target?.category !== 'string' || !target.category.trim()) {
      throw new TypeError(`Target ${index + 1} must have a category.`);
    }
    if (typeof target.url !== 'string') {
      throw new TypeError(`Target ${index + 1} must have a URL.`);
    }

    const url = new URL(target.url);
    if (url.protocol !== 'https:') {
      throw new TypeError(`Target ${index + 1} must use HTTPS.`);
    }
    if (origins.has(url.origin)) {
      throw new TypeError(`Target ${index + 1} has a duplicate origin: ${url.origin}`);
    }
    origins.add(url.origin);

    const category = target.category.trim();
    return {
      id: `${slug(category)}-${slug(url.hostname)}`,
      category,
      url: url.href,
    };
  });
}

export function publicCheckpointTraces(document) {
  if (!Array.isArray(document?.traces)) {
    throw new TypeError('Calibration checkpoint must contain a traces array.');
  }
  return document.traces.filter(
    (trace) => trace?.label === 'public-site-screening' || trace?.label === 'collection-failure',
  );
}
