import path from 'node:path';
import os from 'node:os';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {runGitRead, runGitRemote} from './process.mjs';

const SAFE_REMOTE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,255}$/;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

function remoteName(remote) {
  if (typeof remote !== 'string' || !SAFE_REMOTE.test(remote)) {
    throw new Error('远端必须是 Git 配置名称（例如 origin），不能是 URL、路径或选项');
  }
  return remote;
}

function safeFailure(remote, stage) {
  return Object.assign(new Error('Git 远端 ' + remote + '：' + stage + '失败；请检查远端配置、访问权限与非交互认证，未回退本地版本'), {code: 'code-report/git-remote'});
}

async function safely(remote, stage, signal, fn) {
  signal?.throwIfAborted();
  try { return await fn(); }
  catch { signal?.throwIfAborted(); throw safeFailure(remote, stage); }
}

/** Only the original configured address is inspected; URL and credentials stay private. */
function transportAddress(value, root) {
  if (!value || /[\x00-\x1f\x7f]/.test(value) || value.startsWith('-') || /^[A-Za-z0-9+.-]+::/.test(value)) throw new Error('不支持远端地址');
  if (/^[A-Za-z]:[\\/]/.test(value) || /^[./\\]/.test(value)) return path.resolve(root, value);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    const url = new URL(value);
    if (!['https:', 'http:', 'ssh:', 'git:', 'file:'].includes(url.protocol)) throw new Error('不支持传输协议');
    if (url.protocol !== 'file:' && !url.hostname) throw new Error('缺少远端主机');
    return value;
  }
  // scp syntax, not a Git remote helper (helper::address was rejected above).
  if (/^(?:[^/:@\\]+@)?(?:\[[0-9a-fA-F:]+\]|[^/:@\\]+):[^\r\n]+$/.test(value)) return value;
  if (value.includes(':')) throw new Error('不支持远端地址');
  return path.resolve(root, value);
}

async function configuration(root, remote, signal) {
  remoteName(remote);
  return safely(remote, '读取配置', signal, async () => {
    const canonical = await realpath(root);
    const top = (await runGitRead(['rev-parse', '--show-toplevel'], {cwd: canonical, signal})).trim();
    if (await realpath(top) !== canonical) throw new Error('必须指定 Git 根目录');
    const result = await runGitRead(['config', '--null', '--get-all', 'remote.' + remote + '.url'], {cwd: canonical, signal});
    const urls = result.split('\0').filter(Boolean);
    if (urls.length !== 1) throw new Error('远端 URL 必须唯一');
    const address = transportAddress(urls[0], canonical);
    const format = (await runGitRead(['rev-parse', '--show-object-format'], {cwd: canonical, signal})).trim();
    if (!['sha1', 'sha256'].includes(format)) throw new Error('未知对象格式');
    return {address, format};
  });
}

export function normalizeRemoteRef(ref, remote = 'origin') {
  remoteName(remote);
  if (typeof ref !== 'string' || !ref || ref.length > 256 || /[\x00-\x20\x7f]/.test(ref) || ref.startsWith('-')) throw new Error('无效 Git 远端版本');
  const full = 'refs/remotes/' + remote + '/', short = remote + '/';
  if (ref.startsWith(full)) return 'refs/heads/' + ref.slice(full.length);
  if (ref.startsWith(short)) return 'refs/heads/' + ref.slice(short.length);
  return ref;
}

async function temporary(remote, signal, fn) {
  const directory = await safely(remote, '创建隔离目录', signal, () => mkdtemp(path.join(os.tmpdir(), 'dsh-git-remote-')));
  // The deletion target is exactly the owned absolute directory returned by mkdtemp.
  if (!path.isAbsolute(directory) || !path.basename(directory).startsWith('dsh-git-remote-')) throw new Error('隔离目录无效');
  try { return await fn(directory); }
  finally { await safely(remote, '清理隔离目录', undefined, () => rm(directory, {recursive: true, force: true})); }
}

function parseAdvertisement(text) {
  const refs = [], names = new Set();
  let headTarget = null, headId = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const [value, name, ...extra] = line.split('\t');
    if (extra.length || !name) throw new Error('无效远端引用');
    if (value.startsWith('ref: ')) {
      if (name === 'HEAD') headTarget = value.slice(5);
      continue;
    }
    if (!OBJECT_ID.test(value)) throw new Error('无效远端对象');
    if (name === 'HEAD') { headId = value; continue; }
    if ((name.startsWith('refs/heads/') || name.startsWith('refs/tags/')) && !name.endsWith('^{}')) {
      if (/[\x00-\x20\x7f]/.test(name)) throw new Error('无效远端引用');
      if (!names.has(name)) { refs.push(name); names.add(name); }
    }
  }
  if (headTarget !== null && (!headTarget.startsWith('refs/heads/') || /[\x00-\x20\x7f]/.test(headTarget))) throw new Error('不支持的远端 HEAD');
  return {refs: refs.sort(), headTarget, headId};
}

async function advertisement(directory, address, remote, signal) {
  return safely(remote, '查询引用', signal, async () => parseAdvertisement(await runGitRemote(['ls-remote', '--symref', '--', address, 'HEAD', 'refs/heads/*', 'refs/tags/*'], {cwd: directory, signal})));
}

/** Fresh remote-only refs; no checkout, source-ref update, or local fallback. */
export async function listRemoteRefs(root, {remote = 'origin', signal} = {}) {
  const {address, format} = await configuration(root, remote, signal);
  return temporary(remote, signal, async directory => {
    // A bare root prevents discovery of an ancestor repository or its local configuration.
    await safely(remote, '初始化隔离仓库', signal, () => runGitRead(['init', '--bare', '--template=', '--object-format=' + format, directory], {cwd: directory, signal}));
    return (await advertisement(directory, address, remote, signal)).refs;
  });
}

/** Fully fetch advertised branches/tags into a disposable bare repository. */
export async function withRemoteRepository(root, {remote = 'origin', signal, onProgress = () => {}} = {}, fn) {
  if (typeof fn !== 'function') throw new TypeError('缺少远端读取回调');
  const {address, format} = await configuration(root, remote, signal);
  return temporary(remote, signal, async directory => {
    await safely(remote, '初始化隔离仓库', signal, () => runGitRead(['init', '--bare', '--template=', '--object-format=' + format, directory], {cwd: directory, signal}));
    onProgress({phase: 'remote-fetch', label: '远端 ' + remote + '：抓取完整分支与标签（不修改工作区）'});
    const observed = await advertisement(directory, address, remote, signal);
    await safely(remote, '抓取', signal, () => runGitRemote(['fetch', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance', '--no-tags', '--', address, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'], {cwd: directory, signal}));
    if (observed.headId) {
      await safely(remote, '固定远端 HEAD', signal, async () => {
        if (observed.headTarget) {
          const fetched = (await runGitRead(['rev-parse', '--verify', '--end-of-options', observed.headTarget], {cwd: directory, signal})).trim();
          if (fetched !== observed.headId) throw new Error('远端 HEAD 在采集期间变化');
          await runGitRead(['symbolic-ref', 'HEAD', observed.headTarget], {cwd: directory, signal});
        } else {
          const fetched = (await runGitRead(['rev-parse', '--verify', '--end-of-options', observed.headId + '^{commit}'], {cwd: directory, signal})).trim();
          if (fetched !== observed.headId) throw new Error('远端 HEAD 不属于已抓取历史');
          await runGitRead(['update-ref', '--no-deref', 'HEAD', observed.headId], {cwd: directory, signal});
        }
      });
    } else {
      // init's default branch is never an acceptable substitute for a missing remote HEAD.
      await safely(remote, '标记远端 HEAD 未提供', signal, () => runGitRead(['symbolic-ref', 'HEAD', 'refs/code-report/unavailable-head'], {cwd: directory, signal}));
    }
    signal?.throwIfAborted();
    return fn(directory, {remote, observedAt: new Date().toISOString(), source: 'remote'});
  });
}
