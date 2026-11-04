import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {run} from '../src/process.mjs';

const execute = promisify(execFile);
const processURL = new URL('../src/process.mjs', import.meta.url).href;
const quote = value => '"' + value.replaceAll('\\','/') + '"';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(),'transport-auth-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const home=path.join(directory,'home'), root=path.join(directory,'source'), temp=path.join(directory,'temp.git');
  await Promise.all([mkdir(home),mkdir(root),mkdir(temp)]);
  await run('git',['init','-b','main'],{cwd:root});
  await run('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','fixture'],{cwd:root});
  await run('git',['init','--bare'],{cwd:temp});
  const global=path.join(home,'.gitconfig'), marker=path.join(directory,'transport.json');
  const script=path.join(directory,'fake-ssh.mjs'), identity=path.join(directory,'fixture identity');
  await writeFile(identity,'fixture-token-not-a-private-key');
  await writeFile(script,[
    'import {writeFileSync,readFileSync} from "node:fs";',
    'import {spawnSync} from "node:child_process";',
    'if(process.argv.includes("-G"))process.exit(0);',
    'const i=process.argv.indexOf("-i");',
    'if(i>=0 && readFileSync(process.argv[i+1],"utf8")!=="fixture-token-not-a-private-key")process.exit(17);',
    'writeFileSync('+JSON.stringify(marker)+',JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),env:Object.fromEntries(Object.entries(process.env).filter(([key])=>key.startsWith("GIT_")))}));',
    'const result=spawnSync("git",["upload-pack",'+JSON.stringify(root)+'],{stdio:"inherit"});process.exit(result.status??1);'
  ].join('\n'));
  const command=quote(process.execPath)+' '+quote(script)+' -i '+quote(identity);
  const local=args=>run('git',['config',...args],{cwd:root});
  const user=args=>run('git',['config','--file',global,...args],{cwd:root});
  const child=async(body,env={})=>execute(process.execPath,['--input-type=module','-e',[
    'import assert from "node:assert/strict";',
    'import {runGitRemote,runGitRead,isolatedEnvironment} from '+JSON.stringify(processURL)+';',
    'const root='+JSON.stringify(root)+',temp='+JSON.stringify(temp)+';',body
  ].join('\n')],{cwd:directory,env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^GIT_/i.test(key))),HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:home,...env},maxBuffer:1024*1024,timeout:20000});
  return {directory,home,root,temp,marker,script,identity,command,local,user,child};
}

test('repository-local absolute SSH identity and included auth override global config while network cwd stays temporary',async t=>{
  const f=await fixture(t);
  await f.user(['core.sshCommand','nonexistent-global-ssh']);
  await f.user(['credential.username','global-user']);
  await f.local(['core.sshCommand',f.command]);
  await f.local(['ssh.variant','ssh']);
  await f.local(['credential.username','local-user']);
  const included=path.join(f.directory,'included-auth.config');
  await run('git',['config','--file',included,'http.extraHeader','X-Fixture: local'],{cwd:f.root});
  await f.local(['include.path',included]);
  await f.local(['url.ext::forbidden.insteadOf','ssh://fixture.invalid/']);
  await f.local(['core.hooksPath','forbidden-hooks']);
  await f.local(['core.fsmonitor','forbidden-monitor']);
  await f.local(['remote.origin.uploadpack','forbidden-uploadpack']);
  await f.child([
    'const options={cwd:temp,authenticationRoot:root};',
    'assert.equal((await runGitRemote(["config","--get","credential.username"],options)).trim(),"local-user");',
    'assert.equal((await runGitRemote(["config","--get","ssh.variant"],options)).trim(),"ssh");',
    'const config=await runGitRemote(["config","--list"],options);',
    'assert.ok(config.includes("X-Fixture: local"));',
    'assert.ok(!config.includes("forbidden"));',
    'const raw=await runGitRemote(["ls-remote","--","ssh://fixture.invalid/repository"],{...options,raw:true});',
    'assert.ok(Buffer.isBuffer(raw));assert.ok(raw.toString().includes("HEAD"));'
  ].join('\n'));
  const observed=JSON.parse(await readFile(f.marker,'utf8'));
  assert.equal(observed.cwd,f.temp);
  assert.ok(observed.args.some(value=>value.replaceAll('\\','/')===f.identity.replaceAll('\\','/')));
});

test('remote refs and complete fetch inherit source authentication without modifying source config or refs',async t=>{
  const f=await fixture(t);
  await f.local(['remote.origin.url','ssh://fixture.invalid/repo']);
  const included=path.join(f.directory,'conditional-auth.config');
  await run('git',['config','--file',included,'core.sshCommand',f.command],{cwd:f.root});
  await run('git',['config','--file',included,'ssh.variant','ssh'],{cwd:f.root});
  await f.local(['includeIf.onbranch:main.path',included]);
  const configBefore=await readFile(path.join(f.root,'.git','config'));
  const refsBefore=await run('git',['show-ref'],{cwd:f.root});
  const remoteURL=new URL('../src/git-remote.mjs',import.meta.url).href;
  await f.child([
    'import path from "node:path";',
    'import {readFile,stat} from "node:fs/promises";',
    'import {listRemoteRefs,withRemoteRepository} from '+JSON.stringify(remoteURL)+';',
    'const marker='+JSON.stringify(f.marker)+';',
    'const refs=await listRemoteRefs(root);assert.ok(refs.includes("refs/heads/main"));',
    'let observed=JSON.parse(await readFile(marker,"utf8"));',
    'assert.notEqual(observed.cwd,root);assert.ok(path.basename(observed.cwd).startsWith("dsh-git-remote-"));',
    'assert.ok(observed.args.includes("-i"));',
    'await assert.rejects(stat(observed.cwd),error=>error.code==="ENOENT");',
    'let fetchedRoot;',
    'const expected=(await runGitRead(["rev-parse","HEAD"],{cwd:root})).trim();',
    'await withRemoteRepository(root,{},async temporary=>{fetchedRoot=temporary;assert.equal((await runGitRead(["rev-parse","main"],{cwd:temporary})).trim(),expected);});',
    'observed=JSON.parse(await readFile(marker,"utf8"));assert.equal(observed.cwd,fetchedRoot);assert.ok(observed.args.includes("-i"));',
    'await assert.rejects(stat(fetchedRoot),error=>error.code==="ENOENT");'
  ].join('\n'));
  assert.deepEqual(await readFile(path.join(f.root,'.git','config')),configBefore);
  assert.equal(await run('git',['show-ref'],{cwd:f.root}),refsBefore);
});

test('remote listing reports fixed publickey guidance without leaking SSH stderr secrets and cleans its temp',async t=>{
  const f=await fixture(t), failedSSH=path.join(f.directory,'failed-ssh.mjs');
  const address='ssh://secret-host.invalid/private-repo';
  const secrets=['secret-host.invalid','private-repo','private-user:private-password','private-key-token'];
  const privatePath=path.join(f.directory,'private-key-token');
  await writeFile(failedSSH,[
    'import {writeFileSync} from "node:fs";',
    'if(process.argv.includes("-G"))process.exit(0);',
    'writeFileSync('+JSON.stringify(f.marker)+',JSON.stringify({cwd:process.cwd()}));',
    'process.stderr.write('+JSON.stringify('Permission denied (publickey). ssh://private-user:private-password@secret-host.invalid/private-repo identity '+privatePath+'\n')+');',
    'process.exit(255);'
  ].join('\n'));
  await f.local(['remote.origin.url',address]);
  await f.local(['core.sshCommand',quote(process.execPath)+' '+quote(failedSSH)]);
  await f.local(['ssh.variant','ssh']);
  const remoteURL=new URL('../src/git-remote.mjs',import.meta.url).href;
  await f.child([
    'import {readFile,lstat} from "node:fs/promises";',
    'import {listRemoteRefs} from '+JSON.stringify(remoteURL)+';',
    'const secrets='+JSON.stringify([...secrets,privatePath,address])+';',
    'await assert.rejects(listRemoteRefs(root),error=>{',
    ' assert.equal(error.code,"code-report/git-remote");assert.equal(error.diagnostic,"ssh-publickey");',
    ' assert.equal(error.message,"Git 远端 origin：查询引用失败；SSH 公钥认证被拒绝；请确认当前仓库指定的密钥已在服务器授权，并可由 DSH 运行用户使用；未回退本地版本");',
    ' for(const secret of secrets)assert.ok(!error.message.includes(secret));',
    ' return true;',
    '});',
    'const marker=JSON.parse(await readFile('+JSON.stringify(f.marker)+',"utf8"));',
    'assert.notEqual(marker.cwd,root);await assert.rejects(lstat(marker.cwd),error=>error.code==="ENOENT");'
  ].join('\n'));
});

test('omitted authenticationRoot preserves global-only compatibility and local-only configuration is not implicitly found',async t=>{
  const f=await fixture(t);
  await f.user(['core.sshCommand',f.command]);
  await f.user(['credential.username','global-user']);
  await f.local(['core.sshCommand','forbidden-local-command']);
  await f.local(['credential.username','local-user']);
  await f.child([
    'assert.equal((await runGitRemote(["config","--get","credential.username"],{cwd:temp})).trim(),"global-user");',
    'await runGitRemote(["ls-remote","--","ssh://fixture.invalid/repo"],{cwd:temp});'
  ].join('\n'));
  assert.equal(JSON.parse(await readFile(f.marker,'utf8')).cwd,f.temp);
});

test('explicit GIT_SSH_COMMAND overrides repository command while unrelated Git injection is stripped',async t=>{
  const f=await fixture(t);
  await f.local(['core.sshCommand','forbidden-local-command']);
  await f.child('await runGitRemote(["ls-remote","--","ssh://fixture.invalid/repo"],{cwd:temp,authenticationRoot:root});',{
    GIT_SSH_COMMAND:f.command,GIT_SSH_VARIANT:'ssh',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.sshCommand',GIT_CONFIG_VALUE_0:'forbidden-injected-command',GIT_DIR:'forbidden-directory',GIT_WORK_TREE:'forbidden-worktree',GIT_ALLOW_PROTOCOL:'ext',GIT_ASKPASS:'forbidden-askpass',GIT_TERMINAL_PROMPT:'1'
  });
  const observed=JSON.parse(await readFile(f.marker,'utf8'));
  assert.equal(observed.cwd,f.temp);
  assert.equal(observed.env.GIT_SSH_COMMAND,f.command);
  assert.equal(observed.env.GIT_SSH_VARIANT,'ssh');
  for(const key of ['GIT_DIR','GIT_WORK_TREE','GIT_ALLOW_PROTOCOL','GIT_ASKPASS']) assert.equal(observed.env[key],undefined);
  assert.equal(observed.env.GIT_TERMINAL_PROMPT,'0');
});

test('GIT_SSH executable and variant are preserved only for network runner, not strict local reads',async t=>{
  const f=await fixture(t);
  const bridge=path.join(f.directory,process.platform==='win32'?'ssh-bridge.cmd':'ssh-bridge');
  await writeFile(bridge,process.platform==='win32'?'@echo off\r\n'+quote(process.execPath)+' '+quote(f.script)+' %*\r\n':'#!/bin/sh\nexec '+quote(process.execPath)+' '+quote(f.script)+' "$@"\n',{mode:0o700});
  await f.child([
    'await runGitRemote(["ls-remote","--","ssh://fixture.invalid/repo"],{cwd:temp,authenticationRoot:root});',
    'const read=await runGitRead(["config","--list"],{cwd:temp});assert.ok(!read.includes("injected"));',
    'const localEnv=isolatedEnvironment();for(const key of ["GIT_SSH","GIT_SSH_COMMAND","GIT_SSH_VARIANT"])assert.equal(localEnv[key],undefined);'
  ].join('\n'),{GIT_SSH:bridge,GIT_SSH_VARIANT:'ssh',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'credential.username',GIT_CONFIG_VALUE_0:'injected'});
  const observed=JSON.parse(await readFile(f.marker,'utf8'));
  assert.equal(observed.cwd,f.temp);
  assert.equal(observed.env.GIT_SSH,bridge);
  assert.equal(observed.env.GIT_SSH_VARIANT,'ssh');
});
