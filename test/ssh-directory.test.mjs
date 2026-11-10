import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {sshDirectoryCommand} from '../src/ssh-directory.mjs';
import {runGitRemote,run} from '../src/process.mjs';

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
