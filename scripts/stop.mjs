/**
 * Stop whatever is listening on the server's port.
 *
 * Exists because the usual answer — "press Ctrl+C in the terminal you started
 * it in" — is no help when that terminal is gone, or when something was left
 * running in the background.
 */

import { execSync } from 'node:child_process';

const PORT = Number(process.env.PORT || 8787);

function pidsOnPort(port) {
  const pids = new Set();
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano -p TCP`, { encoding: 'utf8' });
      for (const line of out.split('\n')) {
        if (!line.includes('LISTENING')) continue;
        // Match :PORT at the end of the local-address column, not inside an
        // ephemeral port like 58787.
        if (!new RegExp(`[:\\.]${port}\\s`).test(line)) continue;
        const pid = line.trim().split(/\s+/).pop();
        if (/^\d+$/.test(pid) && pid !== '0') pids.add(pid);
      }
    } else {
      const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8' });
      out.split('\n').map((s) => s.trim()).filter(Boolean).forEach((p) => pids.add(p));
    }
  } catch {
    // No matches at all makes these tools exit non-zero; that is not an error.
  }
  return [...pids];
}

const pids = pidsOnPort(PORT);

if (!pids.length) {
  console.log(`Nothing is listening on port ${PORT}.`);
  process.exit(0);
}

for (const pid of pids) {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
    } else {
      process.kill(Number(pid), 'SIGTERM');
    }
    console.log(`Stopped process ${pid} on port ${PORT}.`);
  } catch (err) {
    console.error(`Could not stop ${pid}: ${err.message}`);
    console.error('If it was started by another user you may need an elevated shell.');
    process.exitCode = 1;
  }
}
