import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {sshDirectoryCommand} from '../src/ssh-directory.mjs';
import {runGitRemote,run} from '../src/process.mjs';
import {remoteFailureDiagnostic,listRemoteRefs} from '../src/git-remote.mjs';
import fsPromises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';

async function fixture(t) {
 const root=await mkdtemp(path.join(os.tmpdir(),'ssh-directory-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const directory=path.join(root,"keys 空格 ' $; .ssh");await mkdir(directory);
 await run('git',['init','--bare',root],{cwd:root});
 return {root,directory};
}
test('blank directory keeps compatibility and invalid values fail without private path disclosure',async()=>{
 for(const value of [undefined,'','  '])assert.equal(await sshDirectoryCommand(value),null);
 for(const value of [null,12,'x\n','x'.repeat(2049)])await assert.rejects(sshDirectoryCommand(value),/SSH 目录配置无效/);
 await assert.rejects(sshDirectoryCommand('relative'),/需要仓库根目录/);
 await assert.rejects(sshDirectoryCommand(path.join(os.tmpdir(),'not-present-private-directory')),error=>!error.message.includes('not-present-private-directory'));
});
test('directory options survive Git shell quoting and OpenSSH parsing without network',async t=>{
 const {root,directory}=await fixture(t);
 await writeFile(path.join(directory,'config'),'Host fixture.invalid\n  User directory-user\n');
 await writeFile(path.join(directory,'id_ed25519'),'not a real private key');
 const command=await sshDirectoryCommand(path.relative(root,directory),root);
 const output=await runGitRemote(['-c','alias.inspect=!'+command+' -G fixture.invalid','inspect'],{cwd:root,authenticationRoot:root,sshDirectory:directory});
 assert.match(output,/user directory-user/);
 assert.ok(output.includes('identityfile '+path.join(directory,'id_ed25519').replaceAll('\\','/')));
 assert.ok(output.includes('userknownhostsfile '+path.join(directory,'known_hosts').replaceAll('\\','/')));
 assert.match(output,/batchmode yes/);
 assert.ok(!output.includes('stricthostkeychecking false'));
});
test('missing config uses empty config and no arbitrary private files are enumerated',async t=>{
 const {root,directory}=await fixture(t);
 await writeFile(path.join(directory,'custom-private-key'),'secret');
 const command=await sshDirectoryCommand(directory,root);
 assert.ok(!command.includes('custom-private-key'));
 assert.ok(command.includes(process.platform==='win32'?'NUL':'/dev/null'));
});

test('explicit custom key resolves absolute and relative paths without changing default SSH configuration',async t=>{
 const {root,directory}=await fixture(t);
 const key=path.join(directory,"custom key ' $; identity");
 await writeFile(key,'not a real private key');
 const command=await sshDirectoryCommand(key,root);
 assert.equal(await sshDirectoryCommand(path.relative(root,key),root),command);
 assert.equal(await sshDirectoryCommand('  '+key+'  ',root),command);
 assert.ok(!command.includes("'-F'"));
 assert.ok(!command.includes('UserKnownHostsFile'));
 assert.ok(!command.includes('StrictHostKeyChecking'));
 const output=await runGitRemote(['-c','alias.inspect=!eval "$GIT_SSH_COMMAND -G fixture.invalid"','inspect'],{cwd:root,authenticationRoot:root,sshDirectory:key});
 assert.ok(output.includes('identityfile '+key.replaceAll('\\','/')));
 assert.match(output,/identitiesonly yes/);
 assert.match(output,/batchmode yes/);
 const defaults=await runGitRemote(['-c','alias.defaults=!ssh -G fixture.invalid','defaults'],{cwd:root,authenticationRoot:root});
 for(const option of ['userknownhostsfile','globalknownhostsfile','stricthostkeychecking']) {
  const setting=text=>text.split(/\r?\n/).find(line=>line.startsWith(option+' '));
  assert.equal(setting(output),setting(defaults),option+' must retain defaults');
 }
});

test('explicit key transport overrides trusted SSH command and variant without contacting a remote',async t=>{
 const {root,directory}=await fixture(t);
 const key=path.join(directory,'custom');await writeFile(key,'not a real private key');
 await run('git',['config','core.sshCommand','must-not-run'],{cwd:root});
 await run('git',['config','ssh.variant','plink'],{cwd:root});
 const names=['GIT_SSH_COMMAND','GIT_SSH','GIT_SSH_VARIANT'];
 const saved=names.map(name=>process.env[name]);
 t.after(()=>names.forEach((name,i)=>{if(saved[i]===undefined)delete process.env[name];else process.env[name]=saved[i];}));
 process.env.GIT_SSH_COMMAND='must-not-run-env';process.env.GIT_SSH='must-not-run';process.env.GIT_SSH_VARIANT='plink';
 const output=await runGitRemote(['-c', 'alias.inspect=!printf "%s\\n" "$GIT_SSH_COMMAND" "$GIT_SSH_VARIANT" "$GIT_SSH"', 'inspect'],{cwd:root,authenticationRoot:root,sshDirectory:key});
 assert.equal(output,(await sshDirectoryCommand(key,root))+'\nssh\n\n');
});

test('unavailable paths return fixed classified errors without raw path disclosure',async t=>{
 const {root,directory}=await fixture(t);
 const key=path.join(directory,'private-path-marker');await writeFile(key,'not a real private key');
 for(const value of [path.join(directory,'missing-private-marker'),path.join(key,'child')]) {
  await assert.rejects(sshDirectoryCommand(value,root),error=>{
   assert.equal(error.message,'SSH 路径不存在或不可访问');
   assert.equal(remoteFailureDiagnostic(error).kind,'ssh-configuration');
   assert.ok(!JSON.stringify(remoteFailureDiagnostic(error)).includes(value));return true;
  });
 }
 for(const message of ['SSH 目录配置无效','相对 SSH 目录需要仓库根目录','SSH 目录不存在或不可读取','无法读取 SSH 目录配置','SSH 路径必须是目录或私钥文件'])assert.equal(remoteFailureDiagnostic(new Error(message)).kind,'ssh-configuration');
 assert.equal(remoteFailureDiagnostic(new Error('SSH 私钥文件不可读取')).kind,'ssh-identity');
});

test('access and stat denials are safely classified without reading private key contents',async t=>{
 const {root,directory}=await fixture(t);
 const key=path.join(directory,'private-denied-marker');await writeFile(key,'not a real private key');
 const originalStat=fsPromises.stat,originalAccess=fsPromises.access;
 const denied=()=>{throw Object.assign(new Error('EACCES private-denied-marker secret raw error'),{code:'EACCES'});};
 const check=async(value,message,kind)=>assert.rejects(sshDirectoryCommand(value,root),error=>{
  assert.equal(error.message,message);assert.equal(error.cause,undefined);
  assert.equal(remoteFailureDiagnostic(error).kind,kind);return true;
 });
 try {
  t.mock.method(fsPromises,'readFile',()=>{throw new Error('private key contents must not be read');});syncBuiltinESMExports();
  assert.match(await sshDirectoryCommand(key,root),/IdentitiesOnly=yes/);
  t.mock.restoreAll();syncBuiltinESMExports();
  t.mock.method(fsPromises,'stat',async()=>({isFile:()=>false,isDirectory:()=>false}));syncBuiltinESMExports();
  await check(key,'SSH 路径必须是目录或私钥文件','ssh-configuration');
  t.mock.restoreAll();syncBuiltinESMExports();
  t.mock.method(fsPromises,'access',denied);syncBuiltinESMExports();
  await check(key,'SSH 私钥文件不可读取','ssh-identity');
  await check(directory,'SSH 目录不存在或不可读取','ssh-configuration');
  t.mock.restoreAll();syncBuiltinESMExports();
  t.mock.method(fsPromises,'stat',async name=>name===key?denied():originalStat(name));syncBuiltinESMExports();
  await check(key,'SSH 路径不存在或不可访问','ssh-configuration');
  t.mock.restoreAll();syncBuiltinESMExports();
  t.mock.method(fsPromises,'stat',async name=>path.resolve(name)===path.join(directory,'config')?denied():originalStat(name));syncBuiltinESMExports();
  await check(directory,'无法读取 SSH 目录配置','ssh-configuration');
 } finally {t.mock.restoreAll();syncBuiltinESMExports();}
 assert.equal(fsPromises.access,originalAccess);
});

test('public key inputs and missing SSH paths surface actionable safe errors through refs',async t=>{
 const {root,directory}=await fixture(t);
 const publicKey=path.join(directory,'private-marker.pub');await writeFile(publicKey,'public fixture');
 await assert.rejects(sshDirectoryCommand(publicKey,root),error=>remoteFailureDiagnostic(error).kind==='ssh-identity'&&!error.message.includes('private-marker'));
 const repository=path.join(root,'source');await mkdir(repository);await run('git',['init',repository],{cwd:root});
 await run('git',['config','remote.origin.url','ssh://fixture.invalid/repository'],{cwd:repository});
 for(const [sshDirectory,kind] of [[publicKey,'ssh-identity'],[path.join(directory,'missing-private-marker'),'ssh-configuration']]) {
  await assert.rejects(listRemoteRefs(repository,{sshDirectory}),error=>{assert.equal(error.diagnostic,kind);assert.match(error.message,/未回退本地版本/);assert.ok(!error.message.includes('private-marker'));assert.ok(!error.message.includes('fixture.invalid'));return true;});
 }
});
