import { readdir, stat } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';

// Desktop updates replace bin/<build> directories. Never consume a queued job
// merely because a previously configured build has disappeared.
export async function resolveCodexPath(configured, { env = process.env, probe } = {}) {
  probe ||= executable => {
    const result = spawnSync(executable, ['--version'], {
      encoding: 'utf8', windowsHide: true, timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return result.status === 0 && /^codex-cli\s/m.test(result.stdout || '');
  };
  const candidates = configured ? [configured] : [];
  if (env.LOCALAPPDATA) {
    const directory = join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    let builds = [];
    try { builds = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const installed = [];
    for (const build of builds.filter(entry => entry.isDirectory())) {
      const executable = join(directory, build.name, 'codex.exe');
      const info = await stat(executable).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (info?.isFile()) installed.push({ executable, modified: info.mtimeMs });
    }
    installed.sort((a, b) => b.modified - a.modified);
    candidates.push(...installed.map(build => build.executable));
  }
  for (const directory of (env.PATH || '').split(delimiter).filter(Boolean)) {
    candidates.push(join(directory, 'codex.exe'));
  }
  for (const executable of new Set(candidates)) {
    const info = await stat(executable).catch(error => {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      return null;
    });
    if (info?.isFile() && await probe(executable)) return executable;
  }
  throw Error('No usable Codex CLI: check the desktop installation before processing agenda requests');
}
