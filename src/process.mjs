import {spawn} from 'node:child_process';
// Keep only a diagnostic prefix of stderr; stdout evidence is never truncated.
const STDERR_DIAGNOSTIC_BYTES = 16 * 1024;
export function isolatedEnvironment(source = process.env) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => !/^GIT_/i.test(key)));
  return {...env, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null'};
}
function decodeUtf8(bytes) { return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes); }

/** Optional caller budgets; wait for process close even when cancellation emits error first. */
export function run(command, args, options = {}) {
  return execute(command, args, options, isolatedEnvironment());
}

/** Report reads must neither contact promisor remotes nor backfill missing objects.
 * Keep this policy separate from run(): fixture init/clone and release tooling are not report reads.
 * GIT_ALLOW_PROTOCOL overrides even repository-specific protocol.<name>.allow settings.
 */
export function runGitRead(args, options = {}) {
  const env = {...isolatedEnvironment(), GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_PROTOCOL_FROM_USER: '0'};
  return execute('git', ['-c', 'protocol.allow=never', ...args], options, env);
}

function execute(command, args, {cwd, signal, maxBytes, timeoutMs, onStdoutBytes} = {}, env) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    if ((timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) ||
        (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1))) throw new Error('无效命令预算');
    const child = spawn(command, args, {cwd, signal, shell: false, windowsHide: true, env});
    let bytes = 0, stdoutBytes = 0, stderrBytes = 0, out = [], err = [], failure, forceTimer, timer;
    const stop = error => {
      if (!failure) failure = error;
      child.kill();
      // A process may ignore SIGTERM on POSIX. Do not leave the request waiting forever.
      if (child.pid && !forceTimer) forceTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    if (timeoutMs !== undefined) {
      const deadline = performance.now() + timeoutMs;
      const expire = () => {
        const remaining = deadline - performance.now();
        if (remaining <= 0) stop(new Error('命令超时（调用者时间预算）'));
        else timer = setTimeout(expire, Math.min(remaining, 2147483647));
      };
      expire();
    }
    const take = (target, stdout) => chunk => {
      if (failure) return;
      bytes += chunk.length;
      if (maxBytes !== undefined && bytes > maxBytes) return stop(new Error('命令输出超出采集上限，未生成不完整报告'));
      if (stdout && onStdoutBytes) {
        stdoutBytes += chunk.length;
        try { onStdoutBytes(stdoutBytes); } catch (error) { stop(error); return; }
      }
      if (stdout) target.push(chunk);
      else if (stderrBytes < STDERR_DIAGNOSTIC_BYTES) {
        const prefix = chunk.subarray(0, STDERR_DIAGNOSTIC_BYTES - stderrBytes);
        target.push(prefix); stderrBytes += prefix.length;
      }
    };
    child.stdout.on('data', take(out, true));
    child.stderr.on('data', take(err, false));
    child.on('error', error => stop(error));
    child.on('close', code => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      if (failure) return reject(failure);
      if (signal?.aborted) return reject(signal.reason);
      if (code !== 0) return reject(new Error(command + ' 读取失败: ' + Buffer.concat(err).toString('utf8').slice(0, 1200)));
      try { resolve(decodeUtf8(Buffer.concat(out))); }
      catch { reject(new Error(command + ' 输出不是有效 UTF-8，已停止采集；可能包含 GBK/GB18030 等编码，请转换或拆分范围后重试，未生成乱码报告')); }
    });
  });
}
