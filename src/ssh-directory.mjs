import path from 'node:path';
import os from 'node:os';
import {stat, access} from 'node:fs/promises';
import {constants} from 'node:fs';

const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const identities = ['id_rsa','id_ecdsa','id_ecdsa_sk','id_ed25519','id_ed25519_sk','id_dsa'];

const failure = (message, identity = false) => Object.assign(new Error(message), {code: identity ? 'code-report/ssh-identity' : 'code-report/ssh-directory'});

/** Explicit directory or private key overrides SSH command/variant only for this invocation. */
export async function sshDirectoryCommand(value, root) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x1f\x7f-\x9f]/.test(value)) throw failure('SSH 目录配置无效');
  const input = value.trim();
  if (!input) return null;
  const expanded = input === '~' ? os.homedir() : /^~[\\/]/.test(input) ? path.join(os.homedir(),input.slice(2)) : input;
  if (!path.isAbsolute(expanded) && !root) throw failure('相对 SSH 目录需要仓库根目录');
  const directory = path.resolve(root ?? '.',expanded);
  let metadata;
  try {metadata = await stat(directory);} catch {throw failure('SSH 路径不存在或不可访问');}
  if (metadata.isFile()) {
    if (/[.]pub$/i.test(directory)) throw failure('SSH 需要私钥文件，不能使用 .pub 公钥',true);
    try {await access(directory,constants.R_OK);} catch {throw failure('SSH 私钥文件不可读取',true);}
    // Do not read the key or override the user's default config/known_hosts.
    return ['ssh','-i',directory.replaceAll('\\','/'),'-o','IdentitiesOnly=yes','-o','BatchMode=yes'].map(quote).join(' ');
  }
  if (!metadata.isDirectory()) throw failure('SSH 路径必须是目录或私钥文件');
  try {await access(directory,constants.R_OK | constants.X_OK);} catch {throw failure('SSH 目录不存在或不可读取');}
  const file = name => path.join(directory,name).replaceAll('\\','/');
  const exists = async name => {try {return (await stat(name)).isFile();} catch(error) {if (error.code === 'ENOENT') return false;throw failure('无法读取 SSH 目录配置');}};
  const config = file('config');
  const args = ['ssh','-F',await exists(config) ? config : (process.platform === 'win32' ? 'NUL' : '/dev/null'),'-o','UserKnownHostsFile='+JSON.stringify(file('known_hosts')),'-o','BatchMode=yes'];
  for (const name of identities) if (await exists(file(name))) args.push('-i',file(name));
  return args.map(quote).join(' ');
}
