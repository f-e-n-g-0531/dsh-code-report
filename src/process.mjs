import {spawn} from 'node:child_process';
const COMMAND_TIMEOUT_MS = 60000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
export function isolatedEnvironment(source = process.env) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => !/^GIT_/i.test(key)));
  return {...env, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null'};
}
function decodeUtf8(bytes) { return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes); }

/** Bound both streams; wait for process close even when cancellation emits error first. */
export function run(command, args, {cwd, signal, maxBytes = DEFAULT_MAX_BYTES, timeoutMs = COMMAND_TIMEOUT_MS, onStdoutBytes} = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('无效命令预算');
    const timeout = Math.min(timeoutMs, COMMAND_TIMEOUT_MS);
    const byteLimit = Math.min(maxBytes, DEFAULT_MAX_BYTES);
    const child = spawn(command, args, {cwd, signal, shell: false, windowsHide: true, env: isolatedEnvironment()});
    let bytes = 0, stdoutBytes = 0, out = [], err = [], failure, forceTimer;
    const stop = error => {
      if (!failure) failure = error;
      child.kill();
      // A process may ignore SIGTERM on POSIX. Do not leave the request waiting forever.
      if (child.pid && !forceTimer) forceTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    const timer = setTimeout(() => stop(new Error(timeout === COMMAND_TIMEOUT_MS ? '命令超时（60 秒）' : '命令超时（采集剩余时间预算）')), timeout);
    const take = (target, stdout) => chunk => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > byteLimit) return stop(new Error('命令输出超出采集上限，未生成不完整报告'));
      if (stdout && onStdoutBytes) {
        stdoutBytes += chunk.length;
        try { onStdoutBytes(stdoutBytes); } catch (error) { stop(error); return; }
      }
      target.push(chunk);
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
