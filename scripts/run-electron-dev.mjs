import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronDir = path.join(root, 'electron');

let electronProcess = null;
let restarting = false;

const server = await createServer({
  root,
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
});

await server.listen();
const address = server.httpServer.address();
const port = typeof address === 'object' && address ? address.port : 5173;
const devServerUrl = `http://127.0.0.1:${port}`;

function startElectron() {
  electronProcess = spawn(electronPath, [root], {
    cwd: root,
    env: {
      ...process.env,
      GRIDLOCK_DEV_SERVER_URL: devServerUrl,
      GRIDLOCK_LIVE_DEV: '1',
    },
    stdio: 'inherit',
  });

  electronProcess.on('exit', async (code) => {
    electronProcess = null;
    if (restarting) {
      restarting = false;
      startElectron();
      return;
    }

    await server.close();
    process.exit(code ?? 0);
  });
}

function restartElectron() {
  if (!electronProcess || restarting) {
    return;
  }

  restarting = true;
  electronProcess.kill();
}

let watchTimer = null;
fs.watch(electronDir, { recursive: true }, () => {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(restartElectron, 150);
});

startElectron();

process.on('SIGINT', async () => {
  electronProcess?.kill();
  await server.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  electronProcess?.kill();
  await server.close();
  process.exit(0);
});
