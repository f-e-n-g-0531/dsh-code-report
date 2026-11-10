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

/** Only fixed diagnostic categories cross the RPC boundary; raw Git stderr may contain secrets. */
export function remoteFailureDiagnostic(error) {
  const message=typeof error?.message==='string'?error.message:'';
  if(error?.code==='code-report/ssh-directory' || /^(?:SSH 目录配置无效|相对 SSH 目录需要仓库根目录|SSH 路径不存在或不可访问|SSH 路径必须是目录或私钥文件|SSH 目录不存在或不可读取|无法读取 SSH 目录配置)$/.test(message)) return {kind:'ssh-configuration',hint:'SSH 路径配置无效、不存在或不可访问；请检查目录或私钥文件及当前运行用户的访问权限'};
  if(error?.code==='code-report/ssh-identity' || message==='SSH 私钥文件不可读取') return {kind:'ssh-identity',hint:'SSH 私钥文件不可用；请填写私钥而非 .pub 公钥，并检查当前运行用户的文件访问权限'};
  const rules=[
    ['ssh-configuration',/bad configuration option|terminating,? .*bad configuration options|(?:can.t|cannot|could not) open (?:user )?config(?:uration)? file|bad owner or permissions on .*config|(?:config|configuration)[^\r\n]*: (?:permission denied|no such file or directory)/i,'SSH 配置无法解析或读取；请检查 SSH config 语法、路径和访问权限'],
    ['ssh-identity',/identity file .*not accessible|no such identity|load key .*|bad permissions|unprotected private key/i,'SSH 密钥无法读取或格式/权限不正确；请检查当前仓库 core.sshCommand 指定的私钥，建议使用绝对路径'],
    ['ssh-publickey',/permission denied[^\n]*(?:publickey|keyboard-interactive)|no supported authentication methods|no authentication methods available|no more authentication methods to try/i,'SSH 公钥认证被拒绝；请确认当前仓库指定的密钥已在服务器授权，并可由 DSH 运行用户使用'],
    ['ssh-host-key',/host key verification failed|remote host identification has changed|authenticity of host .*can.t be established|no .*host key is known/i,'SSH 主机密钥未受信任或已变化；请在终端核验服务器指纹并配置 known_hosts，不会自动跳过主机校验'],
    ['dns',/could not resolve (?:host|hostname)|name or service not known|temporary failure in name resolution|no such host is known|nodename nor servname/i,'无法解析远端主机；请检查域名、VPN 和 DNS'],
    ['proxy',/could not resolve proxy|failed to connect to .*proxy|proxy authentication required|proxy connect aborted|received http code 407|returned error: 407/i,'代理连接或代理认证失败；请检查 Git HTTP/SSH 代理设置'],
    ['connection',/connection refused|connection timed out|operation timed out|failed to connect|network is unreachable|no route to host|connection reset|connection closed|命令超时/i,'远端网络连接失败或超时；请检查网络、VPN、端口及防火墙'],
    ['tls',/ssl certificate|certificate verify failed|server certificate verification failed|schannel:|ssl connect error|unable to get local issuer/i,'TLS 证书校验或握手失败；请检查受信任证书和 Git TLS 配置，不会自动关闭校验'],
    ['authentication',/authentication failed|could not read (?:username|password)|terminal prompts disabled|returned error: (?:401|403)|http[^\n]*(?:401|403)|access denied|permission denied/i,'认证失败或访问被拒绝；请配置当前仓库可用的非交互凭据，并确认仓库读取权限'],
    ['tool',/cannot run .*: no such file|cannot spawn|is not recognized|could not run|unable to fork|cannot exec|command not found/i,'Git、SSH 或认证辅助程序无法启动；请检查 DSH 运行环境中的程序路径'],
    ['repository',/repository .*not found|repository not found|does not appear to be a git repository|could not read from remote repository|project .*not found/i,'远端仓库不存在或当前身份无读取权限；请核对 origin 配置和服务器授权']
  ];
  if(error?.code==='ENOENT')return {kind:'tool',hint:'Git、SSH 或认证辅助程序无法启动；请检查 DSH 运行环境中的程序路径'};
  for(const [kind,pattern,hint] of rules)if(pattern.test(message))return {kind,hint};
  return {kind:'unknown',hint:'无法确认具体原因；请检查远端配置、访问权限与非交互认证（原始输出已隐藏，以免泄露 URL、密钥路径或凭据）'};
}
function safeFailure(remote, stage, error) {
  const diagnostic=remoteFailureDiagnostic(error);
  return Object.assign(new Error('Git 远端 ' + remote + '：' + stage + '失败；'+diagnostic.hint+'；未回退本地版本'), {code: 'code-report/git-remote',diagnostic:diagnostic.kind});
}

async function safely(remote, stage, signal, fn) {
  signal?.throwIfAborted();
  try { return await fn(); }
  catch (error) { signal?.throwIfAborted(); throw safeFailure(remote, stage, error); }
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
    return {address, format, authenticationRoot:canonical};
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

async function advertisement(directory, address, remote, signal, authenticationRoot, sshDirectory) {
  return safely(remote, '查询引用', signal, async () => parseAdvertisement(await runGitRemote(['ls-remote', '--symref', '--', address, 'HEAD', 'refs/heads/*', 'refs/tags/*'], {cwd: directory, signal, authenticationRoot, sshDirectory})));
}

/** Fresh remote-only refs; no checkout, source-ref update, or local fallback. */
export async function listRemoteRefs(root, {remote = 'origin', signal, sshDirectory} = {}) {
  const {address, format, authenticationRoot} = await configuration(root, remote, signal);
  return temporary(remote, signal, async directory => {
    // A bare root prevents discovery of an ancestor repository or its local configuration.
    await safely(remote, '初始化隔离仓库', signal, () => runGitRead(['init', '--bare', '--template=', '--object-format=' + format, directory], {cwd: directory, signal}));
    return (await advertisement(directory, address, remote, signal, authenticationRoot, sshDirectory)).refs;
  });
}

/** Fully fetch advertised branches/tags into a disposable bare repository. */
export async function withRemoteRepository(root, {remote = 'origin', signal, sshDirectory, onProgress = () => {}} = {}, fn) {
  if (typeof fn !== 'function') throw new TypeError('缺少远端读取回调');
  const {address, format, authenticationRoot} = await configuration(root, remote, signal);
  return temporary(remote, signal, async directory => {
    await safely(remote, '初始化隔离仓库', signal, () => runGitRead(['init', '--bare', '--template=', '--object-format=' + format, directory], {cwd: directory, signal}));
    onProgress({phase: 'remote-fetch', label: '远端 ' + remote + '：抓取完整分支与标签（不修改工作区）'});
    const observed = await advertisement(directory, address, remote, signal, authenticationRoot, sshDirectory);
    await safely(remote, '抓取', signal, () => runGitRemote(['fetch', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance', '--no-tags', '--', address, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'], {cwd: directory, signal, authenticationRoot, sshDirectory}));
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
