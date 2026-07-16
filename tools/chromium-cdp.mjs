import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

function browserCandidates() {
  const candidates = [process.env.CHROME_BIN];
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const playwrightRoot = path.join(process.env.LOCALAPPDATA, 'ms-playwright');
    if (existsSync(playwrightRoot)) {
      candidates.push(...readdirSync(playwrightRoot)
        .filter((name) => /^chromium-\d+$/.test(name))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .map((name) => path.join(playwrightRoot, name, 'chrome-win64', 'chrome.exe')));
    }
  }
  candidates.push('chromium', 'chromium-browser', 'google-chrome');
  return candidates.filter(Boolean);
}

export function findBrowser() {
  for (const candidate of browserCandidates()) {
    if (candidate.includes(path.sep) && existsSync(candidate)) return candidate;
    if (process.platform === 'win32') continue;
    const found = spawnSync('sh', ['-lc', `command -v ${JSON.stringify(candidate)}`], {
      encoding: 'utf8',
    });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  throw new Error('No Chromium executable found. Set CHROME_BIN or install Playwright Chromium.');
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(operation, description) {
  const deadline = Date.now() + 10_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

export class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('CDP connection failed.')), {
        once: true,
      });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error('CDP connection closed.'));
      }
      this.pending.clear();
    });
  }

  async send(method, params = {}, timeoutMs = 15_000) {
    await this.ready;
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  close() {
    this.socket.close();
  }
}
