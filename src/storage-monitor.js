(() => {
  const INSTALL_KEY = '__frostguard_storage_monitor_installed_v1__';
  const BRIDGE_API_KEY = '__frostguardIsolatedBridgeV1__';
  const TRANSITION_KEY = '__frostguardStorageGrowthTransitionV1__';
  if (globalThis[INSTALL_KEY]) return;
  Object.defineProperty(globalThis, INSTALL_KEY, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  function finiteBytes(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  async function start() {
    const bridge = globalThis[BRIDGE_API_KEY];
    const transition = globalThis[TRANSITION_KEY];
    if (!bridge || typeof transition !== 'function') return;
    if (window !== window.top) return;
    if (!navigator.storage || typeof navigator.storage.estimate !== 'function') return;

    const config = await bridge.getStorageConfig();
    if (!config?.storageMonitorEnabled) return;

    let state = null;
    let sampleCount = 0;
    const sample = async () => {
      try {
        const estimate = await navigator.storage.estimate();
        const usageBytes = finiteBytes(estimate?.usage);
        if (usageBytes === null) return;
        const result = transition(state, {
          config,
          sample: {
            at: Date.now(),
            usageBytes,
            fileSystemBytes: finiteBytes(estimate?.usageDetails?.fileSystem),
          },
        });
        state = result.state;
        if (result.event) {
          bridge.reportStorageSignal({
            ...result.event,
            quotaBytes: finiteBytes(estimate?.quota) || 0,
          });
        }
      } catch {
        state = null;
      } finally {
        sampleCount += 1;
        const delay = sampleCount < 2 ? 1_500 : sampleCount < 12 ? 5_000 : 15_000;
        setTimeout(sample, delay);
      }
    };

    void sample();
  }

  void start();
})();
