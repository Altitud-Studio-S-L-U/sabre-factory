#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctor } from '../infra/platform.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [command = 'help', ...args] = process.argv.slice(2);
const operatorCommands = new Set(['runs', 'run', 'watch', 'ask', 'answer', 'pause', 'resume', 'cancel']);
const operations = new Set(['init', 'config', 'build', 'prepare', 'prepare-codex', 'prepare-claude', 'up', 'open', 'down', 'status',
  'logs', 'slack', 'telemetry', 'stop', 'codex-login', 'claude-login', 'migrate-credentials']);
try {
  if (command === 'help' || command === '--help') {
    console.log('SABRE Factory\n\nsabre <command>   (or node bin/sabre.mjs <command>; run npm link once to install sabre)\n\n'
      + 'Factory: doctor, init, config, build, prepare, prepare-codex, prepare-claude, up [--no-open], open, down, status, logs, backup, verify, restore, slack, telemetry, codex-login, claude-login\n'
      + 'Runs: runs, run, watch, ask, answer, pause, resume, cancel (sabre runs help)\n'
      + 'Harness: bench, mcp, mcp-stdio\n\nup opens the panel already signed in; open pairs another browser.');
  } else {
    const report = await doctor();
    if (command === 'doctor') console.log(JSON.stringify(report, null, 2));
    else if (command === 'mcp-stdio') {
      if (args.length) throw new Error('mcp-stdio does not accept arguments.');
      const child = spawn('docker', ['exec', '-i', 'sabre-factory-api-1', '/app/.venv/bin/python', '-I', '-m', 'sabre.mcp_stdio'], { cwd: root, stdio: 'inherit', windowsHide: true });
      process.exitCode = await new Promise((ok, fail) => { child.once('error', fail); child.once('exit', (code) => ok(code ?? 1)); });
    } else {
      const script = operations.has(command) ? 'ops.mjs' : ['backup', 'verify', 'restore'].includes(command) ? 'backup.mjs' : command === 'mcp' ? 'mcp.mjs' : command === 'bench' ? 'bench.mjs' : operatorCommands.has(command) ? 'cli.mjs' : null;
      if (!script) throw new Error('Unknown command. Run node bin/sabre.mjs help.');
      const child = spawn(process.execPath, [resolve(root, 'infra', script), ...(['mcp', 'bench'].includes(command) ? args : [command, ...args])],
        { cwd: root, stdio: 'inherit', windowsHide: true });
      process.exitCode = await new Promise((ok, fail) => { child.once('error', fail); child.once('exit', (code) => ok(code ?? 1)); });
    }
  }
} catch (error) {
  console.error(error.message.startsWith('Command failed:') ? 'Docker is unavailable. Start Docker Desktop or Docker Engine and select a local Linux context.' : error.message);
  process.exitCode = 1;
}
