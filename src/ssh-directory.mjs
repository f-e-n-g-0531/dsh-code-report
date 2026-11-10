import path from 'node:path';
import os from 'node:os';
import {stat} from 'node:fs/promises';

const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const identities = ['id_rsa','id_ecdsa','id_ecdsa_sk','id_ed25519','id_ed25519_sk','id_dsa'];

/** Explicit directory overrides SSH command/variant only for this network invocation. */
export async function sshDirectoryCommand(value, root) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x1f\x7f-\x9f]/.test(value)) throw new Error('SSH 目录配置无效');
  const input = value.trim();
  if (!input) return null;
  const expanded = input === '~' ? os.homedir() : /^~[\\/]/.test(input) ? path.join(os.homedir(),input.slice(2)) : input;
  if (!path.isAbsolute(expanded) && !root) throw new Error('相对 SSH 目录需要仓库根目录');
  const directory = path.resolve(root ?? '.',expanded);
  const file = name => path.join(directory,name).replaceAll('\\','/');
  const exists = async name => {try {return (await stat(name)).isFile();} catch(error) {if (error.code === 'ENOENT') return false;throw new Error('无法读取 SSH 目录配置');}};
  try {if (!(await stat(directory)).isDirectory()) throw new Error();} catch {throw new Error('SSH 目录不存在或不可读取');}
  const config = file('config');
  const args = ['ssh','-F',await exists(config) ? config : (process.platform === 'win32' ? 'NUL' : '/dev/null'),'-o','UserKnownHostsFile='+JSON.stringify(file('known_hosts')),'-o','BatchMode=yes'];
  for (const name of identities) if (await exists(file(name))) args.push('-i',file(name));
  return args.map(quote).join(' ');
}
