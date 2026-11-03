// A deliberately killable owner. Its stdin pipe is the launcher's liveness channel.
import { spawn } from 'node:child_process';
const [host, ...args] = process.argv.slice(2);
const child = spawn(host, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
process.stdout.write(`${JSON.stringify({ type: 'owner-host', pid: child.pid })}\n`);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.once('error', () => { process.exitCode = 1; child.stdin.destroy(); });
child.once('close', code => { process.exitCode = code ?? 1; child.stdin.destroy(); });
