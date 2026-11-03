import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {run} from '../src/process.mjs';

const execute = promisify(execFile);

for (const reason of [null, 0, false, '']) {
  test('process-tree abort preserves falsy reason ' + JSON.stringify(reason), {timeout: 10000}, async () => {
    const controller = new AbortController();
    // The child only announces readiness and idles; its own deadline is emergency cleanup.
    const pending = run(process.execPath, ['-e', 'setTimeout(()=>process.exit(91),6000);setInterval(()=>{},1000);process.stdout.write("ready");'], {
      killTree: true, signal: controller.signal,
      onStdoutBytes() { controller.abort(reason); }
    });
    let timer;
    const outcome = await Promise.race([
      pending.then(() => ({resolved: true}), error => ({rejected: true, reason: error})),
      new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('falsy abort failed to settle within 4 seconds')), 4000);})
    ]).finally(() => clearTimeout(timer));
    assert.equal(controller.signal.aborted, true);
    assert.equal(outcome.rejected, true);
    assert.equal(outcome.reason, reason);
  });
}

test('abort kills fake SSH descendants, settles with original reason and cleans remote temp', {timeout: 40000}, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'remote-abort-test-'));
  const root = path.join(directory, 'source'), home = path.join(directory, 'home'), temps = path.join(directory, 'temps');
  await Promise.all([mkdir(root), mkdir(home), mkdir(temps)]);
  const marker = path.join(directory, 'ssh-started.json'), helper = path.join(directory, 'fake-ssh.mjs');
  t.after(async () => {
    // Emergency cleanup is independent of transport correctness, including test timeouts.
    let state;
    try { state = JSON.parse(await readFile(marker, 'utf8')); } catch { /* Helper never started. */ }
    for (const pid of [state?.sshPid, state?.pid]) {
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (process.platform === 'win32') await execute('taskkill.exe', ['/PID', String(pid), '/T', '/F']).catch(() => {});
      else { try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ } }
    }
    await rm(directory, {recursive: true, force: true});
  });
  await run('git', ['init', '-b', 'main'], {cwd: root});
  await run('git', ['config', 'remote.origin.url', 'ssh://fixture.invalid/never-network.git'], {cwd: root});
  const grandchild = [
    'const fs=require("node:fs");',
    'process.on("SIGTERM",()=>{});',
    'fs.writeFileSync(' + JSON.stringify(marker) + ',JSON.stringify({pid:process.pid,sshPid:process.ppid,cwd:process.cwd()}));',
    'setInterval(()=>{},1000);'
  ].join('\n');
  await writeFile(helper, [
    'import {spawn} from "node:child_process";',
    'if(process.argv.includes("-G"))process.exit(0);',
    'process.on("SIGTERM",()=>{});',
    'spawn(process.execPath,["-e",' + JSON.stringify(grandchild) + '],{stdio:"inherit"});',
    'setInterval(()=>{},1000);'
  ].join('\n'));
  const quote = value => '"' + value.replaceAll('\\', '/') + '"';
  await run('git', ['config', '--file', path.join(home, '.gitconfig'), 'core.sshCommand', quote(process.execPath) + ' ' + quote(helper)], {cwd: root});
  const moduleURL = new URL('../src/git-remote.mjs', import.meta.url).href;
  const script = [
    'import assert from "node:assert/strict";',
    'import {watch} from "node:fs";',
    'import {readFile,readdir,stat} from "node:fs/promises";',
    'import {withRemoteRepository} from ' + JSON.stringify(moduleURL) + ';',
    'const marker=' + JSON.stringify(marker) + ',temps=' + JSON.stringify(temps) + ';',
    'function bounded(promise,ms,label){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]).finally(()=>clearTimeout(timer));}',
    'function started(){let watcher,timer,busy=false;return new Promise((resolve,reject)=>{',
    ' const check=async()=>{if(busy)return;busy=true;try{const value=JSON.parse(await readFile(marker,"utf8"));clearTimeout(timer);watcher.close();resolve(value);}catch(error){if(error.code!=="ENOENT"&&!(error instanceof SyntaxError)){clearTimeout(timer);watcher.close();reject(error);}}finally{busy=false;}};',
    ' watcher=watch(' + JSON.stringify(directory) + ',check);timer=setTimeout(()=>{watcher.close();reject(new Error("fake SSH never started"));},10000);void check();',
    '});}',
    'function dead(pid){try{process.kill(pid,0);return false;}catch(error){if(error.code==="ESRCH")return true;throw error;}}',
    'const controller=new AbortController(),reason=new Error("exact caller abort");',
    'const ready=started();let callback=false;',
    'const pending=withRemoteRepository(' + JSON.stringify(root) + ',{signal:controller.signal},async()=>{callback=true;});',
    'const outcome=pending.then(()=>({ok:true}),error=>({error}));',
    'try{',
    ' const state=await ready;',
    ' assert.equal(dead(state.pid),false,"SSH grandchild must really be running");',
    ' assert.equal(dead(state.sshPid),false,"SSH helper must really be running");',
    ' assert.ok(state.cwd.startsWith(temps),"transport must run in isolated temp");',
    ' controller.abort(reason);',
    ' const result=await bounded(outcome,8000,"abort did not settle after descendant close");',
    ' assert.equal(result.error,reason,"preserve exact signal reason");assert.equal(callback,false);',
    ' assert.equal(dead(state.pid),true,"grandchild dead when operation settles");',
    ' assert.equal(dead(state.sshPid),true,"SSH helper dead when operation settles");',
    ' await assert.rejects(stat(state.cwd),error=>error.code==="ENOENT");',
    ' assert.deepEqual(await readdir(temps),[],"finally removes owned remote bare repo");',
    '}finally{controller.abort(reason);}'
  ].join('\n');
  await execute(process.execPath, ['--input-type=module', '-e', script], {
    cwd: directory, env: {...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, TMPDIR: temps, TMP: temps, TEMP: temps},
    timeout: 25000, maxBuffer: 1024 * 1024
  });
});
