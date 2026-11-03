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

/** Network reads are only for caller-owned temporary bare repositories, never report worktrees.
 * Retain credential/TLS/SSH settings without inheriting URL rewrites, hooks or remote helpers. */
export async function runGitRemote(args, options = {}) {
  const source = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const safe = ['-c','core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),'-c','core.fsmonitor=false'];
  const configuration = await execute('git', [...safe,'config','--null','--list','--includes'], {...options,raw:false,onStdoutBytes:undefined}, source);
  options.signal?.throwIfAborted();
  const retained = [];
  for (const record of configuration.split('\0')) {
    const split = record.indexOf('\n');
    if (split < 0) continue;
    const key = record.slice(0,split), value = record.slice(split+1);
    if (/^(?:credential[.]|http[.])|^core[.]sshcommand$/i.test(key)) retained.push([key,value]);
  }
  const env = {...isolatedEnvironment(source), GIT_TERMINAL_PROMPT:'0', GCM_INTERACTIVE:'never', GIT_CONFIG_COUNT:String(retained.length)};
  retained.forEach(([key,value],index) => { env['GIT_CONFIG_KEY_' + index] = key; env['GIT_CONFIG_VALUE_' + index] = value; });
  const protocols = ['-c','protocol.allow=never', ...['file','http','https','ssh','git'].flatMap(name => ['-c','protocol.' + name + '.allow=always']),'-c','protocol.ext.allow=never'];
  return execute('git', [...safe,...protocols,'-c','fetch.recurseSubmodules=false','-c','submodule.recurse=false',...args], {...options,killTree:true}, env);
}

function execute(command, args, {cwd, signal, maxBytes, timeoutMs, onStdoutBytes, raw = false, killTree = false} = {}, env) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    if ((timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) ||
        (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1))) throw new Error('无效命令预算');
    const child = spawn(command, args, {cwd, signal:killTree?undefined:signal, detached:killTree&&process.platform!=='win32', shell: false, windowsHide: true, env});
    let bytes = 0, stdoutBytes = 0, stderrBytes = 0, out = [], err = [], failure, stopped = false, forceTimer, timer;
    let treeStopped = Promise.resolve();
    const stop = error => {
      if (stopped) return;
      stopped = true;failure = error;
      if(killTree&&child.pid&&process.platform==='win32'){
        treeStopped=new Promise(resolve=>{
          const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
          killer.on('error',()=>{child.kill();resolve();});killer.on('close',()=>{child.kill();resolve();});
        });
      }else{
        const terminate=force=>{try{if(killTree&&child.pid)process.kill(-child.pid,force?'SIGKILL':'SIGTERM');else child.kill(force?'SIGKILL':'SIGTERM');}catch{child.kill(force?'SIGKILL':'SIGTERM');}};
        terminate(false);
        if(killTree&&child.pid)treeStopped=new Promise(resolve=>{forceTimer=setTimeout(()=>{terminate(true);resolve();},1000);});
        else if (child.pid && !forceTimer) forceTimer = setTimeout(() => terminate(true), 1000);
      }
    };
    const onAbort=()=>stop(signal.reason);
    if(killTree){signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();}
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
      if (stopped) return;
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
    child.on('close', async code => {
      signal?.removeEventListener('abort',onAbort);
      await treeStopped;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      if (stopped) return reject(failure);
      if (signal?.aborted) return reject(signal.reason);
      if (code !== 0) return reject(new Error(command + ' 读取失败: ' + Buffer.concat(err).toString('utf8').slice(0, 1200)));
      const output = Buffer.concat(out);
      if (raw === true) return resolve(output);
      try { resolve(decodeUtf8(output)); }
      catch { reject(new Error(command + ' 元数据输出不是有效 UTF-8，无法安全解析路径或协议，已停止采集')); }
    });
  });
}
