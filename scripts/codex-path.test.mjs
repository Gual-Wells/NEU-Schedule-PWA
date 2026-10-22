import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { resolveCodexPath } from './codex-path.mjs';

test('desktop update removes configured build; skip incomplete newer build and find usable CLI', async () => {
  const temporaryRoot = resolve(process.env.TEMP || process.env.TMP);
  const directory = await mkdtemp(join(temporaryRoot, 'agenda-codex-'));
  try {
    const bin = join(directory, 'OpenAI', 'Codex', 'bin');
    for (const build of ['working', 'broken', 'incomplete']) await mkdir(join(bin, build), { recursive: true });
    const working = join(bin, 'working', 'codex.exe'), broken = join(bin, 'broken', 'codex.exe');
    await writeFile(working, 'fixture'); await writeFile(broken, 'fixture');
    await utimes(working, new Date(1000), new Date(1000));
    await utimes(broken, new Date(2000), new Date(2000));
    const probed = [], options = { env: { LOCALAPPDATA: directory, PATH: '' }, probe: file => { probed.push(file); return file === working; } };
    assert.equal(await resolveCodexPath(join(bin, 'removed', 'codex.exe'), options), working);
    assert.deepEqual(probed, [broken, working]);
    await assert.rejects(resolveCodexPath(null, { ...options, probe: () => false }), /No usable Codex CLI/);
  } finally {
    assert.equal(dirname(resolve(directory)), temporaryRoot);
    await rm(directory, { recursive: true, force: true });
  }
});
