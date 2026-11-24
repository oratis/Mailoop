import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('stopping the demo drains the application and removes its disposable cluster', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mailoop-shutdown-check-'));
  const demo = spawn(process.execPath, ['--import', 'tsx', 'scripts/demo.ts'], {
    env: { ...process.env, TMPDIR: directory }, stdio: ['ignore', 'pipe', 'inherit']
  });
  const exit = once(demo, 'exit');
  const deadline = setTimeout(() => demo.kill('SIGKILL'), 30000);
  try {
    let output = '';
    demo.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes('Ctrl+C')) demo.kill('SIGTERM');
    });
    const [code] = await exit;
    assert.equal(code, 0);
    assert.ok(output.includes('Ctrl+C'));
    assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('mailoop-')), []);
  } finally {
    clearTimeout(deadline);
    await rm(directory, { recursive: true, force: true });
  }
});
