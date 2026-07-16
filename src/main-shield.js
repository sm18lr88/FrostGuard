(() => {
  'use strict';

  const root = globalThis;
  const INSTALL_KEY = '__frostguard_main_shield_installed_v1__';
  const PAGE_MESSAGE_MARKER = '__frostguard_page_event_v1__';
  const BRIDGE_READY_MARKER = '__frostguard_bridge_ready_v1__';
  const pendingEvents = [];

  try {
    if (Object.prototype.hasOwnProperty.call(root, INSTALL_KEY)) return;
    Object.defineProperty(root, INSTALL_KEY, {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  } catch {
    if (root[INSTALL_KEY]) return;
    root[INSTALL_KEY] = true;
  }

  const native = {
    defineProperty: Object.defineProperty,
    getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
    getPrototypeOf: Object.getPrototypeOf,
    reflectApply: Reflect.apply,
    reflectConstruct: Reflect.construct,
    promiseReject: Promise.reject,
    DOMException: root.DOMException,
    Error: root.Error,
    postMessage:
      typeof root.postMessage === 'function' ? root.postMessage.bind(root) : null,
    setTimeout:
      typeof root.setTimeout === 'function' ? root.setTimeout.bind(root) : null,
    addEventListener: EventTarget.prototype.addEventListener,
    stopImmediatePropagation: Event.prototype.stopImmediatePropagation,
    createObjectURL:
      root.URL && typeof root.URL.createObjectURL === 'function'
        ? root.URL.createObjectURL.bind(root.URL)
        : null,
    revokeObjectURL:
      root.URL && typeof root.URL.revokeObjectURL === 'function'
        ? root.URL.revokeObjectURL.bind(root.URL)
        : null,
    Worker: root.Worker,
    SharedWorker: root.SharedWorker,
    Blob: root.Blob,
    URL: root.URL,
  };

  function securityError(api) {
    const message = `${api} was blocked by FROST Guard to prevent storage timing fingerprinting.`;
    try {
      return new native.DOMException(message, 'SecurityError');
    } catch {
      const error = new native.Error(message);
      error.name = 'SecurityError';
      return error;
    }
  }

  function sendPageEvent(eventType, detail = {}) {
    if (!native.postMessage) return;

    const payload = {
      [PAGE_MESSAGE_MARKER]: true,
      version: 1,
      eventType,
      detail: {
        ...detail,
        blocked: detail.blocked !== false,
        context: detail.context || 'window',
        crossOriginIsolated: Boolean(root.crossOriginIsolated),
        secureContext: Boolean(root.isSecureContext),
      },
    };

    pendingEvents.push(payload);
    if (pendingEvents.length > 20) pendingEvents.shift();

    try {
      native.postMessage(payload, '*');
    } catch {
      // Reporting must never weaken the blocking path.
    }
  }

  try {
    native.reflectApply(native.addEventListener, root, [
      'message',
      (event) => {
        if (event?.source !== root || event?.data?.[BRIDGE_READY_MARKER] !== true) {
          return;
        }
        for (const payload of pendingEvents) {
          try {
            native.postMessage(payload, '*');
          } catch {
            break;
          }
        }
      },
      true,
    ]);
  } catch {
    // Direct reporting still works when the bridge is already attached.
  }

  function defineLockedMethod(target, key, replacement) {
    if (!target) return false;

    try {
      const descriptor = native.getOwnPropertyDescriptor(target, key);
      if (descriptor && descriptor.configurable === false && descriptor.value !== replacement) {
        return false;
      }
      native.defineProperty(target, key, {
        configurable: false,
        enumerable: descriptor?.enumerable ?? false,
        writable: false,
        value: replacement,
      });
      return true;
    } catch {
      return false;
    }
  }

  function makeDeniedPromiseMethod(eventType, api, functionName) {
    const denied = function () {
      sendPageEvent(eventType, { api, blocked: true });
      return native.reflectApply(native.promiseReject, Promise, [securityError(api)]);
    };

    try {
      native.defineProperty(denied, 'name', { value: functionName });
    } catch {
      // Function metadata is cosmetic.
    }
    return denied;
  }

  function patchPrototypeMethod(constructorName, methodName, eventType, apiLabel = null) {
    const Constructor = root[constructorName];
    const prototype = Constructor?.prototype;
    if (!prototype) return false;

    const descriptor = native.getOwnPropertyDescriptor(prototype, methodName);
    if (!descriptor || typeof descriptor.value !== 'function') return false;

    return defineLockedMethod(
      prototype,
      methodName,
      makeDeniedPromiseMethod(
        eventType,
        apiLabel || `${constructorName}.${methodName}`,
        methodName,
      ),
    );
  }

  function patchStorageRoot() {
    const storage = root.navigator?.storage;
    const storagePrototype = storage ? native.getPrototypeOf(storage) : null;
    const denied = makeDeniedPromiseMethod(
      'opfs-blocked',
      'navigator.storage.getDirectory',
      'getDirectory',
    );

    let patched = defineLockedMethod(storagePrototype, 'getDirectory', denied);
    if (!patched && root.StorageManager?.prototype) {
      patched = defineLockedMethod(root.StorageManager.prototype, 'getDirectory', denied);
    }
    if (!patched && storage) {
      defineLockedMethod(storage, 'getDirectory', denied);
    }
  }

  function wrapPicker(methodName, apiLabel) {
    const original = root[methodName];
    if (typeof original !== 'function') return;

    const wrapped = function (...args) {
      sendPageEvent('file-picker-observed', {
        api: apiLabel,
        blocked: false,
      });
      return native.reflectApply(original, this, args);
    };

    try {
      native.defineProperty(wrapped, 'name', { value: methodName });
    } catch {
      // Cosmetic only.
    }
    defineLockedMethod(root, methodName, wrapped);
  }

  function randomToken() {
    try {
      if (root.crypto?.randomUUID) return root.crypto.randomUUID();
      const bytes = new Uint8Array(16);
      root.crypto.getRandomValues(bytes);
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    } catch {
      return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
  }

  function workerBootstrap(channel, originalURL, isModule) {
    'use strict';

    const ports = new Set();

    if ('onconnect' in self && typeof self.addEventListener === 'function') {
      self.addEventListener('connect', (event) => {
        for (const port of event.ports || []) {
          ports.add(port);
          try {
            port.start();
          } catch {
            // Port may already be started.
          }
        }
      });
    }

    const emit = (eventType, api) => {
      const message = {
        __frostguardWorkerChannel: channel,
        eventType,
        detail: {
          api,
          blocked: true,
          context: 'worker',
          crossOriginIsolated: Boolean(self.crossOriginIsolated),
          secureContext: Boolean(self.isSecureContext),
        },
      };

      try {
        if (typeof self.postMessage === 'function') self.postMessage(message);
      } catch {
        // Dedicated worker reporting is best effort.
      }

      for (const port of ports) {
        try {
          port.postMessage(message);
        } catch {
          ports.delete(port);
        }
      }
    };

    const makeError = (api) => {
      const text = `${api} was blocked by FROST Guard to prevent storage timing fingerprinting.`;
      try {
        return new DOMException(text, 'SecurityError');
      } catch {
        const error = new Error(text);
        error.name = 'SecurityError';
        return error;
      }
    };

    // A classic worker normally resolves relative importScripts() URLs against
    // its own script URL. Because the shield uses a short-lived blob bootstrap,
    // preserve that behavior by resolving subsequent imports against the
    // original worker URL instead of the blob URL.
    if (!isModule && typeof self.importScripts === 'function') {
      try {
        const nativeImportScripts = self.importScripts.bind(self);
        const resolveImport = (value) => new URL(String(value), originalURL).href;
        Object.defineProperty(self, 'importScripts', {
          value: (...urls) => nativeImportScripts(...urls.map(resolveImport)),
          configurable: false,
          enumerable: true,
          writable: false,
        });
      } catch {
        // Some engines expose importScripts as non-configurable. The original
        // worker still loads; only nested relative classic imports may differ.
      }
    }

    const lockMethod = (target, key, eventType, api) => {
      if (!target) return;
      try {
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        if (!descriptor || typeof descriptor.value !== 'function') return;
        const denied = function () {
          emit(eventType, api);
          return Promise.reject(makeError(api));
        };
        try {
          Object.defineProperty(denied, 'name', { value: key });
        } catch {
          // Cosmetic only.
        }
        Object.defineProperty(target, key, {
          value: denied,
          configurable: false,
          enumerable: descriptor.enumerable,
          writable: false,
        });
      } catch {
        // A missing patch is still covered by the other entry-point patches.
      }
    };

    try {
      const storage = self.navigator?.storage;
      lockMethod(
        storage ? Object.getPrototypeOf(storage) : self.StorageManager?.prototype,
        'getDirectory',
        'worker-opfs-blocked',
        'navigator.storage.getDirectory',
      );
    } catch {
      // Continue with additional entry points.
    }

    lockMethod(
      self.StorageManager?.prototype,
      'getDirectory',
      'worker-opfs-blocked',
      'StorageManager.getDirectory',
    );
    lockMethod(
      self.StorageBucket?.prototype,
      'getDirectory',
      'worker-opfs-blocked',
      'StorageBucket.getDirectory',
    );
    lockMethod(
      self.FileSystemFileHandle?.prototype,
      'createSyncAccessHandle',
      'worker-sync-access-blocked',
      'FileSystemFileHandle.createSyncAccessHandle',
    );
    lockMethod(
      self.FileSystemFileHandle?.prototype,
      'createAccessHandle',
      'worker-sync-access-blocked',
      'FileSystemFileHandle.createAccessHandle',
    );
  }

  function resolveWorkerURL(scriptURL) {
    const base = root.document?.baseURI || root.location?.href;
    return new native.URL(String(scriptURL), base).href;
  }

  function attachWorkerReporter(workerLike, channel) {
    const listener = (event) => {
      const data = event?.data;
      if (!data || data.__frostguardWorkerChannel !== channel) return;
      try {
        native.reflectApply(native.stopImmediatePropagation, event, []);
      } catch {
        // Reporting still works if event propagation cannot be stopped.
      }
      sendPageEvent(data.eventType || 'worker-opfs-blocked', data.detail || {});
    };

    try {
      const target = workerLike?.port || workerLike;
      native.reflectApply(native.addEventListener, target, ['message', listener, true]);
      if (workerLike?.port && typeof workerLike.port.start === 'function') {
        workerLike.port.start();
      }
    } catch {
      // Worker-side blocking still works even if reporting cannot be attached.
    }
  }

  function makeWorkerWrapper(NativeConstructor, constructorName) {
    if (
      typeof NativeConstructor !== 'function' ||
      typeof native.Blob !== 'function' ||
      typeof native.createObjectURL !== 'function' ||
      typeof native.URL !== 'function'
    ) {
      return null;
    }

    const WrappedWorker = function (scriptURL, options) {
      if (!new.target) {
        throw new TypeError(`Failed to construct '${constructorName}': Please use the 'new' operator.`);
      }

      const resolvedURL = resolveWorkerURL(scriptURL);
      const channel = randomToken();
      let type = 'classic';
      try {
        if (options?.type === 'module') type = 'module';
      } catch {
        // Let the native constructor handle malformed options later.
      }

      const bootstrap = `(${workerBootstrap.toString()})(${JSON.stringify(channel)}, ${JSON.stringify(resolvedURL)}, ${type === 'module'});\n`;
      const loader =
        type === 'module'
          ? `import(${JSON.stringify(resolvedURL)}).catch((error) => setTimeout(() => { throw error; }));\n`
          : `importScripts(${JSON.stringify(resolvedURL)});\n`;
      const wrapperURL = native.createObjectURL(
        new native.Blob([bootstrap, loader], { type: 'text/javascript' }),
      );

      let worker;
      try {
        const args = options === undefined ? [wrapperURL] : [wrapperURL, options];
        const constructionTarget =
          new.target === WrappedWorker ? NativeConstructor : new.target;
        worker = native.reflectConstruct(NativeConstructor, args, constructionTarget);
      } catch (error) {
        try {
          native.revokeObjectURL?.(wrapperURL);
        } catch {
          // Ignore cleanup failure.
        }
        sendPageEvent('worker-construction-blocked', {
          api: `${constructorName} constructor`,
          blocked: true,
          reason: 'worker-wrapper-construction-failed',
        });
        throw error;
      }

      attachWorkerReporter(worker, channel);
      if (native.setTimeout && native.revokeObjectURL) {
        native.setTimeout(() => {
          try {
            native.revokeObjectURL(wrapperURL);
          } catch {
            // Best-effort cleanup.
          }
        }, 30_000);
      }

      return worker;
    };

    try {
      native.defineProperty(WrappedWorker, 'name', { value: constructorName });
      native.defineProperty(WrappedWorker, 'length', { value: 1 });
      WrappedWorker.prototype = NativeConstructor.prototype;
      // Closing this alternate constructor path prevents pages from bypassing
      // the global wrapper with `new Worker.prototype.constructor(...)`.
      defineLockedMethod(NativeConstructor.prototype, 'constructor', WrappedWorker);
    } catch {
      // Metadata preservation is best effort.
    }

    return WrappedWorker;
  }

  patchStorageRoot();
  patchPrototypeMethod(
    'StorageBucket',
    'getDirectory',
    'bucket-opfs-blocked',
    'StorageBucket.getDirectory',
  );
  patchPrototypeMethod(
    'FileSystemFileHandle',
    'createSyncAccessHandle',
    'sync-access-blocked',
    'FileSystemFileHandle.createSyncAccessHandle',
  );
  patchPrototypeMethod(
    'FileSystemFileHandle',
    'createAccessHandle',
    'sync-access-blocked',
    'FileSystemFileHandle.createAccessHandle',
  );

  wrapPicker('showOpenFilePicker', 'window.showOpenFilePicker');
  wrapPicker('showDirectoryPicker', 'window.showDirectoryPicker');

  const WorkerWrapper = makeWorkerWrapper(native.Worker, 'Worker');
  if (WorkerWrapper) defineLockedMethod(root, 'Worker', WorkerWrapper);

  const SharedWorkerWrapper = makeWorkerWrapper(native.SharedWorker, 'SharedWorker');
  if (SharedWorkerWrapper) defineLockedMethod(root, 'SharedWorker', SharedWorkerWrapper);
})();
