(() => {
  const TRANSITION_KEY = '__frostguardStorageGrowthTransitionV1__';
  const POLICY = Object.freeze({
    cooldownMs: 60_000,
    maxEpisodeMs: 45_000,
    maxGapMs: 30_000,
    quietResetMs: 30_000,
  });
  if (globalThis[TRANSITION_KEY]) return;

  function finiteBytes(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function metricFor(sample) {
    return finiteBytes(sample.fileSystemBytes) === null ? 'total' : 'file-system';
  }

  function metricBytes(sample, metric) {
    return metric === 'file-system'
      ? finiteBytes(sample.fileSystemBytes)
      : finiteBytes(sample.usageBytes);
  }

  function thresholdFor(config, metric) {
    return metric === 'file-system'
      ? finiteBytes(config.fileSystemGrowthThresholdBytes)
      : finiteBytes(config.totalGrowthThresholdBytes);
  }

  function absoluteState(previous, sample, config) {
    const fileSystemBytes = finiteBytes(sample.fileSystemBytes);
    const threshold = finiteBytes(config.absoluteFileSystemWarningBytes);
    const above = fileSystemBytes !== null && threshold !== null && fileSystemBytes >= threshold;
    return {
      absoluteCount: above ? (previous?.absoluteCount || 0) + 1 : 0,
      absoluteSent: previous?.absoluteSent === true,
    };
  }

  function prime(sample, absolute) {
    const metric = metricFor(sample);
    const bytes = metricBytes(sample, metric);
    return {
      phase: 'tracking',
      metric,
      baselineAt: sample.at,
      baselineBytes: bytes,
      previousAt: sample.at,
      previousBytes: bytes,
      candidateBytes: null,
      sampleCount: 1,
      cooldownUntil: 0,
      quietSince: null,
      ...absolute,
    };
  }

  function eventFor(reason, state, sample, thresholdBytes) {
    const fileSystemBytes = finiteBytes(sample.fileSystemBytes);
    const deltaBytes = reason === 'large-file-system-usage'
      ? 0
      : Math.max(0, metricBytes(sample, state.metric) - state.baselineBytes);
    return {
      reason,
      api: 'navigator.storage.estimate',
      blocked: false,
      usageBytes: finiteBytes(sample.usageBytes) || 0,
      fileSystemBytes: fileSystemBytes || 0,
      deltaBytes,
      windowMs: Math.max(0, sample.at - state.baselineAt),
      thresholdBytes,
    };
  }

  function withObservation(state, sample, absolute) {
    const bytes = metricBytes(sample, state.metric);
    const quietSince = bytes === state.previousBytes
      ? state.quietSince ?? state.previousAt
      : null;
    return {
      ...state,
      previousAt: sample.at,
      previousBytes: bytes,
      sampleCount: state.sampleCount + 1,
      quietSince,
      ...absolute,
    };
  }

  function transitionStorageGrowth(previous, input) {
    const sample = input?.sample || {};
    const config = input?.config || {};
    const at = finiteBytes(sample.at);
    const usageBytes = finiteBytes(sample.usageBytes);
    if (at === null || usageBytes === null) {
      return { state: previous || null, event: null };
    }

    const normalizedSample = {
      at,
      usageBytes,
      fileSystemBytes: finiteBytes(sample.fileSystemBytes),
    };
    const absolute = absoluteState(previous, normalizedSample, config);
    if (!previous) {
      return { state: prime(normalizedSample, absolute), event: null };
    }

    const metric = metricFor(normalizedSample);
    const bytes = metricBytes(normalizedSample, metric);
    const gapMs = at - previous.previousAt;
    const episodeMs = at - previous.baselineAt;
    if (
      metric !== previous.metric ||
      gapMs <= 0 ||
      gapMs > POLICY.maxGapMs ||
      bytes < previous.previousBytes ||
      (episodeMs > POLICY.maxEpisodeMs && previous.phase !== 'cooldown')
    ) {
      return { state: prime(normalizedSample, absolute), event: null };
    }

    let state = withObservation(previous, normalizedSample, absolute);
    if (state.phase === 'cooldown') {
      const quietFor = state.quietSince === null ? 0 : at - state.quietSince;
      if (at >= state.cooldownUntil && quietFor >= POLICY.quietResetMs) {
        state = prime(normalizedSample, absolute);
      }
      return { state, event: null };
    }

    const threshold = thresholdFor(config, metric);
    const growth = bytes - state.baselineBytes;
    let rapidEvent = null;
    if (state.phase === 'tracking' && threshold !== null && growth >= threshold) {
      state = { ...state, phase: 'confirming', candidateBytes: bytes };
    } else if (
      state.phase === 'confirming' &&
      threshold !== null &&
      bytes >= state.candidateBytes &&
      growth >= threshold
    ) {
      rapidEvent = eventFor(
        metric === 'file-system'
          ? 'confirmed-file-system-growth'
          : 'confirmed-total-usage-growth',
        state,
        normalizedSample,
        threshold,
      );
      state = {
        ...state,
        phase: 'cooldown',
        cooldownUntil: at + POLICY.cooldownMs,
        absoluteSent: state.absoluteSent || state.absoluteCount >= 2,
      };
    }

    if (rapidEvent) return { state, event: rapidEvent };

    const absoluteThreshold = finiteBytes(config.absoluteFileSystemWarningBytes);
    if (!state.absoluteSent && state.absoluteCount >= 2 && absoluteThreshold !== null) {
      const event = eventFor(
        'large-file-system-usage',
        state,
        normalizedSample,
        absoluteThreshold,
      );
      return { state: { ...state, absoluteSent: true }, event };
    }

    return { state, event: null };
  }

  Object.defineProperty(globalThis, TRANSITION_KEY, {
    value: Object.freeze(transitionStorageGrowth),
    configurable: false,
    enumerable: false,
    writable: false,
  });
})();
