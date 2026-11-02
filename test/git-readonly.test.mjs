import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {run, runGitRead} from '../src/process.mjs';
import {collect, listRefs} from '../src/collect.mjs';

async function workspace(t) {
 const cwd = await mkdtemp(path.join(tmpdir(), 'report-readonly-'));
 t.after(() => rm(cwd, {recursive:true, force:true}));
 return cwd;
}
async function seed(root) {
 await mkdir(root);
 const git = args => run('git', args, {cwd:root});
 await git(['init', '-b', 'main']);
 await git(['config', 'user.name', 'Fixture']);
 await git(['config', 'user.email', 'fixture@example.invalid']);
 await writeFile(path.join(root, 'api.txt'), 'first\n\nlast\n');
 await writeFile(path.join(root, 'context.txt'), 'unchanged context\n');
 await git(['add', '.']); await git(['commit', '-m', 'base']);
 const a = (await git(['rev-parse', 'HEAD'])).trim();
 await writeFile(path.join(root, 'api.txt'), 'first changed\n\nlast\n');
 await git(['commit', '-am', 'target']);
 const b = (await git(['rev-parse', 'HEAD'])).trim();
 return {git, a, b};
}
async function filesState(root) {
 const entries = [];
 async function walk(dir) {
  for (const entry of await readdir(dir, {withFileTypes:true})) {
   const file = path.join(dir, entry.name);
   if (entry.isDirectory()) await walk(file);
   else if (entry.isFile()) entries.push([path.relative(root,file), createHash('sha256').update(await readFile(file)).digest('hex'), (await stat(file)).mtimeMs]);
  }
 }
 await walk(root);
 return entries.sort((a,b) => a[0].localeCompare(b[0]));
}

test('real filtered clone report reads fail locally without invoking promisor transport or writing objects', async t => {
 const cwd = await workspace(t);
 const source = path.join(cwd, 'source');
 const {git, a, b} = await seed(source);
 await git(['config', 'uploadpack.allowFilter', 'true']);
 await git(['config', 'uploadpack.allowAnySHA1InWant', 'true']);
 const root = path.join(cwd, 'partial');
 // Setup intentionally uses the general runner: reports must not globally disable clone.
 await run('git', ['clone','--filter=blob:none','--no-checkout','--no-local',pathToFileURL(source).href,root], {cwd});
 const local = args => run('git', args, {cwd:root});
 assert.equal((await local(['config','--get','remote.origin.promisor'])).trim(), 'true');
 const blob = (await git(['rev-parse', a + ':api.txt'])).trim();
 const marker = path.join(cwd, 'transport-contacted.txt');
 const script = path.join(cwd, 'transport.mjs');
 await writeFile(script, 'import {writeFileSync} from "node:fs"; writeFileSync(process.argv[2],"contacted"); process.exit(1);');
 const helper = JSON.stringify(process.execPath.replaceAll('\\','/')) + ' ' + JSON.stringify(script.replaceAll('\\','/')) + ' ' + JSON.stringify(marker.replaceAll('\\','/'));
 await local(['config', 'remote.origin.uploadpack', helper]);
 // A named protocol allow override must not defeat the runner policy.
 await local(['config', 'protocol.file.allow', 'always']);
 const before = await filesState(path.join(root, '.git'));
 const missing = await runGitRead(['rev-list','--objects','--all','--missing=print'], {cwd:root});
 assert.ok(missing.split('\n').includes('?' + blob), 'filtered clone must actually lack the baseline blob');
 await assert.rejects(runGitRead(['cat-file','-e',blob], {cwd:root}));
 const request = {repositories:[{path:'partial',type:'git',a,b}]};
 await assert.rejects(collect(cwd, request));
 const same = {repositories:[{path:'partial',type:'git',a:b,b}],versionContexts:[{repository:'partial',side:'B',path:'context.txt'}]};
 await assert.rejects(collect(cwd, same));
 assert.ok((await listRefs(cwd,'partial')).includes('refs/heads/main'));
 await assert.rejects(readFile(marker), error => error.code === 'ENOENT');
 assert.deepEqual(await filesState(path.join(root,'.git')), before);
 // Transport is also denied explicitly; fetch itself may create an empty FETCH_HEAD,
 // so this negative transport probe is outside the read-only snapshot assertion.
 await assert.rejects(runGitRead(['fetch','origin'], {cwd:root}), /not allowed|不允许/);
 await assert.rejects(readFile(marker), error => error.code === 'ENOENT');
 // Prove the helper is live and our sentinel is capable of detecting a transport attempt.
 await assert.rejects(local(['fetch','origin']));
 assert.equal(await readFile(marker, 'utf8'), 'contacted');
});

test('Git report patch syntax is invariant under repository display configuration', async t => {
 const cwd = await workspace(t);
 const root = path.join(cwd,'repo');
 const {git,a,b} = await seed(root);
 const request = {repositories:[{path:'repo',type:'git',a,b}]};
 const baseline = (await collect(cwd, request)).repositories[0];
 const configurations = [
  ['diff.noprefix','true'], ['diff.mnemonicPrefix','true'], ['diff.srcPrefix','BEFORE/'], ['diff.dstPrefix','AFTER/'],
  ['diff.relative','true'], ['diff.suppressBlankEmpty','true'], ['diff.interHunkContext','100'], ['diff.context','0'],
  ['diff.algorithm','histogram'], ['diff.indentHeuristic','true'], ['diff.renames','copies'], ['diff.submodule','diff'],
  ['color.ui','always'], ['core.quotePath','true'],
 ];
 for (const [key,value] of configurations) await git(['config', key, value]);
 const configured = (await collect(cwd, request)).repositories[0];
 assert.deepEqual(configured.files, baseline.files);
 assert.equal(configured.diff, baseline.diff);
 assert.equal(configured.diffHash, baseline.diffHash);
 assert.match(configured.diff, /^diff --git a\/api.txt b\/api.txt/m);
 assert.match(configured.diff, /^ $/m);
 assert.doesNotMatch(configured.diff, /BEFORE|AFTER|\u001b/);
});
