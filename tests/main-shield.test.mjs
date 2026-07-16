import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = await readFile(new URL('../src/main-shield.js', import.meta.url), 'utf8');

function makeContext() {
  const messages = [];

  class StorageManager {
    getDirectory() {
      return Promise.resolve({ native: true });
    }
  }

  class StorageBucket {
    getDirectory() {
      return Promise.resolve({ native: true });
    }
  }

  class FileSystemFileHandle {
    createSyncAccessHandle() {
      return Promise.resolve({ native: true });
    }

    createAccessHandle() {
      return Promise.resolve({ native: true });
    }
  }

  class MockWorker extends EventTarget {
    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
    }
  }

  const context = vm.createContext({
    Blob,
    DOMException,
    Event,
    EventTarget,
    FileSystemFileHandle,
    SharedWorker: undefined,
    StorageBucket,
    StorageManager,
    URL,
    Uint8Array,
    Worker: MockWorker,
    console,
    crypto: webcrypto,
    crossOriginIsolated: false,
    document: { baseURI: 'https://attacker.example/page' },
    isSecureContext: true,
    location: { href: 'https://attacker.example/page' },
    navigator: { storage: new StorageManager() },
    postMessage(message) {
      messages.push(message);
    },
    // The production shield revokes worker bootstrap URLs after 30 seconds.
    // A no-op scheduler keeps this VM unit test from holding Node open.
    setTimeout: () => 0,
    showDirectoryPicker: async () => 'directory-picked',
    showOpenFilePicker: async () => 'file-picked',
  });

  return { context, messages, MockWorker };
}

function isSecurityError(error) {
  return error?.name === 'SecurityError' && /FROST Guard/.test(error?.message || '');
}

test('blocks window OPFS and synchronous file-system entry points', async () => {
  const { context, messages } = makeContext();
  vm.runInContext(source, context, { filename: 'main-shield.js' });

  await assert.rejects(context.navigator.storage.getDirectory(), isSecurityError);
  await assert.rejects(new context.StorageBucket().getDirectory(), isSecurityError);
  await assert.rejects(
    new context.FileSystemFileHandle().createSyncAccessHandle(),
    isSecurityError,
  );
  await assert.rejects(
    new context.FileSystemFileHandle().createAccessHandle(),
    isSecurityError,
  );

  assert.deepEqual(
    messages.map((message) => message.eventType),
    ['opfs-blocked', 'bucket-opfs-blocked', 'sync-access-blocked', 'sync-access-blocked'],
  );
  assert.equal(messages[0].__frostguard_page_event_v1__, true);
  assert.equal(messages[0].detail.blocked, true);
});

test('locks patched descriptors against page restoration', () => {
  const { context } = makeContext();
  vm.runInContext(source, context, { filename: 'main-shield.js' });

  const storageDescriptor = Object.getOwnPropertyDescriptor(
    context.StorageManager.prototype,
    'getDirectory',
  );
  assert.equal(storageDescriptor.configurable, false);
  assert.equal(storageDescriptor.writable, false);
  assert.throws(() => {
    Object.defineProperty(context.StorageManager.prototype, 'getDirectory', {
      value: () => Promise.resolve('restored'),
    });
  }, TypeError);
});

test('reports but does not block user-mediated file pickers', async () => {
  const { context, messages } = makeContext();
  vm.runInContext(source, context, { filename: 'main-shield.js' });

  assert.equal(await context.showOpenFilePicker(), 'file-picked');
  assert.equal(await context.showDirectoryPicker(), 'directory-picked');
  assert.deepEqual(
    messages.map((message) => [message.eventType, message.detail.blocked]),
    [
      ['file-picker-observed', false],
      ['file-picker-observed', false],
    ],
  );
});

test('wraps workers and closes Worker.prototype.constructor bypass', () => {
  const { context, MockWorker } = makeContext();
  vm.runInContext(source, context, { filename: 'main-shield.js' });

  assert.notEqual(context.Worker, MockWorker);
  assert.equal(context.Worker.prototype.constructor, context.Worker);
  assert.notEqual(Object.getPrototypeOf(context.Worker), MockWorker);
  const descriptor = Object.getOwnPropertyDescriptor(
    context.Worker.prototype,
    'constructor',
  );
  assert.equal(descriptor.configurable, false);
  assert.equal(descriptor.writable, false);

  const worker = new context.Worker('./probe.js', { name: 'probe' });
  assert.ok(worker instanceof MockWorker);
  assert.match(worker.url, /^blob:/);
  assert.equal(worker.options.name, 'probe');

  class DerivedWorker extends context.Worker {}
  const derived = new DerivedWorker('./derived.js');
  assert.ok(derived instanceof DerivedWorker);
  assert.ok(derived instanceof MockWorker);
});

test('installation is idempotent', async () => {
  const { context, messages } = makeContext();
  vm.runInContext(source, context, { filename: 'main-shield.js' });
  const firstMethod = context.navigator.storage.getDirectory;
  vm.runInContext(source, context, { filename: 'main-shield.js' });
  assert.equal(context.navigator.storage.getDirectory, firstMethod);

  await assert.rejects(context.navigator.storage.getDirectory(), isSecurityError);
  assert.equal(messages.length, 1);
});
