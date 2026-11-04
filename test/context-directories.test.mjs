import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, symlink, opendir, rename} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {expandContextPaths, resolveContextFile} from '../src/context-paths.mjs';
import {createCollectionBudget} from '../src/budget.mjs';
import {collect} from '../src/collect.mjs';
import {run} from '../src/process.mjs';

async function workspace(t) {
 const cwd = await mkdtemp(path.join(os.tmpdir(), 'report-context-directories-'));
 t.after(() => rm(cwd, {recursive:true, force:true}));
 return cwd;
}
async function file(cwd, name, value = 'text') {
 const target = path.join(cwd, name);
 await mkdir(path.dirname(target), {recursive:true});
 await writeFile(target, value);
}
const expand = (cwd, names, options) => expandContextPaths(cwd, names, createCollectionBudget(), options);
async function repo(cwd) {
 const root = path.join(cwd, 'repo');
 await mkdir(root);
 const git = args => run('git', args, {cwd:root});
 await git(['init', '-b', 'main']);
 await git(['config', 'user.name', 'Fixture']);
 await git(['config', 'user.email', 'fixture@example.invalid']);
 await file(root, 'historical.txt', 'pinned');
 await git(['add', '.']);
 await git(['commit', '-m', 'baseline']);
 const id = (await git(['rev-parse', 'HEAD'])).trim();
 return {path:'repo', type:'git', a:id, b:id};
}

test('nested source trees use deterministic order, canonical dedup and workspace root', async t => {
 const cwd = await workspace(t);
 for (const name of ['src/z.cpp','src/nested/Makefile','src/A.h','readme.md']) await file(cwd, name);
 const expected = ['src/A.h','src/nested/Makefile','src/z.cpp'];
 assert.deepEqual((await expand(cwd, ['src'])).paths, expected);
 assert.deepEqual((await expand(cwd, ['src/nested','src/z.cpp','src','./src/A.h','src'])).paths, expected);
 assert.deepEqual((await expand(cwd, ['.'])).paths, ['readme.md', ...expected]);
});

test('automatic directory selection includes source, shader, build, config and docs case-insensitively', async t => {
 const cwd = await workspace(t);
 const names=['logic.CPP','public.H','Client.cs','Script.LUA','data.JSON','schema.Xml','Client.vcxproj','tool.cmake','Makefile','math.inl','render.shader','Dockerfile','README','license','CMakeLists.txt','nested/fragment.HLSL','nested/message.proto','web.tsx'];
 for(const name of names)await file(cwd,'src/'+name,'// readable source/config');
 assert.deepEqual((await expand(cwd,['src'])).paths,names.map(name=>'src/'+name).sort());
});

test('automatic non-source binaries are metadata-only exclusions while explicit files remain strict', async t => {
 const cwd=await workspace(t),row=await repo(cwd);
 const extensions=['sdf','DLL','png','lib','pdb','o','zip','exe'];
 for(const extension of extensions)await file(cwd,'src/asset.'+extension,Buffer.from('NON_SOURCE_BODY_MUST_NOT_APPEAR\0\xff'));
 await file(cwd,'src/unknown.custom','CUSTOM_TEXT_BODY');await file(cwd,'src/plain','PLAIN_BODY');await file(cwd,'src/good.cpp','int good;');
 const expanded=await expand(cwd,['src']);assert.deepEqual(expanded.paths,['src/good.cpp']);
 const notes=expanded.limitations.join('\n');assert.match(notes,/已排除 10 个/);assert.match(notes,/非源码扩展名统计/);assert.match(notes,/示例/);assert.match(notes,/未读取这些文件正文/);
 for(const extension of extensions)assert.ok(notes.includes('.'+extension.toLowerCase()+' 1 项'));assert.ok(notes.includes('.custom 1 项'));
 const typeNotes=expanded.limitations.find(note=>note.includes('非源码扩展名统计'));assert.ok(typeNotes);const examples=typeNotes.split('示例：')[1].split('；')[0].split('、');assert.equal(examples.length,5);assert.ok(notes.includes('(无扩展名) 1 项'));
 assert.ok(!JSON.stringify(expanded).includes('NON_SOURCE_BODY'));
 const captured=await collect(cwd,{repositories:[row],contextPaths:['src']});assert.deepEqual(captured.context.map(item=>item.path),['src/good.cpp']);assert.ok(!JSON.stringify(captured).includes('NON_SOURCE_BODY'));
 for(const extension of extensions)await assert.rejects(collect(cwd,{repositories:[row],contextPaths:['src/asset.'+extension]}),error=>/二进制/.test(error.message)&&error.message.includes('src/asset.'+extension));
});

test('unknown text explicit override works before and after a directory without reading unrelated bodies', async t => {
 const cwd=await workspace(t),row=await repo(cwd);await file(cwd,'src/custom.custom','custom text');await file(cwd,'src/ok.cpp','int ok;');await file(cwd,'src/binary.sdf',Buffer.from([0,255]));
 for(const paths of [['src','src/custom.custom'],['src/custom.custom','src'],['src','src/custom.custom','src']]){
  const expanded=await expand(cwd,paths);assert.deepEqual(expanded.paths,['src/custom.custom','src/ok.cpp']);const notes=expanded.limitations.join('\n');assert.match(notes,/已排除 1 个/);assert.match(notes,/\.sdf 1 项/);assert.ok(!notes.includes('custom.custom'));assert.ok(!notes.includes('.custom 1 项'));
  const captured=await collect(cwd,{repositories:[row],contextPaths:paths});assert.deepEqual(captured.context.map(item=>item.path),['src/custom.custom','src/ok.cpp']);assert.equal(captured.context[0].text,'custom text');
 }
 await file(cwd,'src/bad.custom',Buffer.from([0x81]));await assert.rejects(collect(cwd,{repositories:[row],contextPaths:['src','src/bad.custom']}),error=>/UTF-8/.test(error.message)&&error.message.includes('src/bad.custom'));
});

test('secret, hidden and dependency/build entries skip before body reads with exclusion counts', async t => {
 const cwd = await workspace(t);
 const excluded = ['.env','.env.local','id_rsa','id_ed25519','thing.pem','thing.key','thing.p12','thing.pfx','credentials/token','.git/config','.svn/wc.db','node_modules/pkg/index','dist/output','build/output','Library/a','Temp/a','obj/a','bin/a','coverage/a','cache/a','.hidden/a','.hiddenfile'];
 for (const name of excluded) await file(cwd, 'src/' + name, Buffer.from([0, 0xff]));
 await file(cwd, 'src/good.cpp', 'safe');
 const result = await expand(cwd, ['src']);
 assert.deepEqual(result.paths, ['src/good.cpp']);
 assert.match(result.limitations.join('\n'), /已排除 22 个/);
 assert.match(result.limitations.join('\n'), /secretPath.*隐藏路径.*依赖|依赖.*secretPath.*隐藏路径/);
 assert.ok(!JSON.stringify(result).includes('token'));
 for (const name of ['src/.env','src/credentials','src/.git','src/node_modules','src/thing.pem']) await assert.rejects(expand(cwd, [name]), /禁止采集/);
});

test('empty directories and explicitly skipped build paths yield zero files and limitations', async t => {
 const cwd = await workspace(t);
 await mkdir(path.join(cwd, 'empty'));
 await file(cwd, 'build/generated', Buffer.from([0]));
 const empty = await expand(cwd, ['empty']);
 assert.deepEqual(empty.paths, []);
 assert.match(empty.limitations.join('\n'), /1 个目录为 0 个.*empty/);
 const skipped = await expand(cwd, ['build']);
 assert.deepEqual(skipped.paths, []);
 assert.match(skipped.limitations.join('\n'), /排除 1 个.*构建产物/);
});

test('junction directory roots, ancestors, nested aliases and secret aliases never follow', async t => {
 const cwd = await workspace(t);
 await file(cwd, 'credentials/private', 'SECRET_BODY_MUST_NOT_LEAK');
 await file(cwd, 'src/good.cpp', 'ok');
 await symlink(path.join(cwd, 'credentials'), path.join(cwd, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
 await symlink(path.join(cwd, 'src'), path.join(cwd, 'src-alias'), process.platform === 'win32' ? 'junction' : 'dir');
 await symlink(path.join(cwd, 'credentials'), path.join(cwd, 'src/nested-alias'), process.platform === 'win32' ? 'junction' : 'dir');
 for (const name of ['alias','alias/private','src-alias','src-alias/good.cpp']) {
  const result = await expand(cwd, [name]);
  assert.deepEqual(result.paths, []);
  assert.match(result.limitations.join('\n'), /junction/);
  assert.ok(!JSON.stringify(result).includes('SECRET_BODY'));
 }
 const nested = await expand(cwd, ['src']);
 assert.deepEqual(nested.paths, ['src/good.cpp']);
 assert.match(nested.limitations.join('\n'), /junction/);
 // A symlink in cwd itself or any ancestor also must not be resolved away.
 assert.deepEqual((await expand(path.join(cwd, 'src-alias'), ['.'])).paths, []);
 const outer = await workspace(t);
 await symlink(cwd, path.join(outer, 'workspace-alias'), process.platform === 'win32' ? 'junction' : 'dir');
 assert.deepEqual((await expand(path.join(outer, 'workspace-alias', 'src'), ['.'])).paths, []);
});

test('file symlinks including secret aliases are excluded without content access', async t => {
 const cwd = await workspace(t);
 await file(cwd, '.env', 'SECRET');
 try { await symlink(path.join(cwd, '.env'), path.join(cwd, 'innocent.txt'), 'file'); }
 catch (error) { if (error.code === 'EPERM') { t.skip('OS denies file symlink creation; junction coverage runs separately'); return; } throw error; }
 const result = await expand(cwd, ['.']);
 assert.deepEqual(result.paths, []);
 assert.match(result.limitations.join('\n'), /junction/);
});

test('streaming expansion exceeds former entry, directory, depth and file caps without omission', async t => {
 const cwd = await workspace(t);
 for (let i = 0; i < 2000; i++) await file(cwd, 'wide/.skip-' + i);
 await file(cwd, 'wide/good.cpp', 'complete');
 const wide = await expand(cwd, ['wide']);
 assert.deepEqual(wide.paths, ['wide/good.cpp']);
 assert.match(wide.limitations.join('\n'), /已排除 2000 个/);
 for (let i = 0; i < 256; i++) await mkdir(path.join(cwd, 'dirs', String(i)), {recursive:true});
 await file(cwd, 'dirs/255/good.cpp');
 assert.deepEqual((await expand(cwd, ['dirs'])).paths, ['dirs/255/good.cpp']);
 await mkdir(path.join(cwd, 'deep', ...Array(21).fill('n')), {recursive:true});
 const deepFile = ['deep', ...Array(21).fill('n'), 'good.cpp'].join('/');
 await file(cwd, deepFile);
 assert.deepEqual((await expand(cwd, ['deep'])).paths, [deepFile]);
 for (let i = 0; i < 21; i++) await file(cwd, 'files/' + i + '.cpp');
 assert.equal((await expand(cwd, ['files'])).paths.length, 21);
});

test('cancellation before and during asynchronous scanning and deadline checks never return partial results', async t => {
 const cwd = await workspace(t);
 await file(cwd, 'tree/nested/good.cpp');
 const controller = new AbortController();
 controller.abort(new Error('cancelled-before'));
 await assert.rejects(expandContextPaths(cwd, ['tree'], createCollectionBudget({signal:controller.signal})), /cancelled-before/);
 const probe = await opendir(path.join(cwd, 'tree'));
 const prototype = Object.getPrototypeOf(probe);
 await probe.close();
 const originalRead = prototype.read;
 const during = new AbortController();
 let captured;
 const mock = t.mock.method(prototype, 'read', async function(...args) {
  captured = this;
  const entry = await originalRead.apply(this, args);
  during.abort(new Error('cancelled-during'));
  return entry;
 });
 try {
  await assert.rejects(expandContextPaths(cwd, ['tree'], createCollectionBudget({signal:during.signal})), /cancelled-during/);
  assert.ok(captured);
  await assert.rejects(originalRead.call(captured), /closed/);
 } finally { mock.mock.restore(); }
 let clock = 0;
 await assert.rejects(expandContextPaths(cwd, ['tree'], createCollectionBudget({now:() => ++clock,timeoutMs:30})), /总时间/);
});

test('collect expands before repository I/O and sets expanded progress totals; provenance and hash stay intact', async t => {
 const cwd = await workspace(t), row = await repo(cwd);
 await file(cwd, 'context/z.cpp', '最后');
 await file(cwd, 'context/a.cpp', 'first');
 const progress = [];
 const result = await collect(cwd, {repositories:[row],contextPaths:['context','context/a.cpp']}, undefined, value => progress.push(value));
 assert.deepEqual(result.context.map(item => item.path), ['context/a.cpp','context/z.cpp']);
 for (const item of result.context) {
  assert.equal(item.provenance, 'current-workspace');
  assert.equal(item.hash, createHash('sha256').update(item.text).digest('hex'));
 }
 assert.ok(progress.every(item => item.total === 3));
 assert.equal(progress.at(-1).completed, 3);
 await file(cwd, 'context/.env', 'SECRET_BODY_NOT_IN_PREVIEW');
 const filtered = await collect(cwd, {repositories:[row],contextPaths:['context']});
 assert.match(filtered.limitations.join('\n'), /排除 1 个.*secretPath/);
 assert.ok(!JSON.stringify(filtered).includes('SECRET_BODY_NOT_IN_PREVIEW'));
 const invalidRepo = {...row,path:'missing-repo'};
 for (let i = 0; i < 21; i++) await file(cwd, 'many/' + i + '.cpp');
 await assert.rejects(collect(cwd, {repositories:[invalidRepo],contextPaths:['many']}), /ENOENT/);
 assert.equal((await collect(cwd, {repositories:[row],contextPaths:['many']})).context.length, 21);
 await mkdir(path.join(cwd, 'context-empty'));
 const snapshot = await collect(cwd, {repositories:[row],contextPaths:['context-empty']});
 assert.deepEqual(snapshot.context, []);
 assert.match(snapshot.limitations.join('\n'), /1 个目录为 0 个.*context-empty/);
});

test('selected directory replaced by a junction after expansion cannot expose a secret alias', async t => {
 const cwd = await workspace(t);
 await file(cwd, 'context/good.cpp', 'safe');
 await file(cwd, 'credentials/good.cpp', 'SECRET_BODY_NOT_READ');
 const expanded = await expand(cwd, ['context']);
 assert.deepEqual(expanded.paths, ['context/good.cpp']);
 await rename(path.join(cwd, 'context'), path.join(cwd, 'old-context'));
 await symlink(path.join(cwd, 'credentials'), path.join(cwd, 'context'), process.platform === 'win32' ? 'junction' : 'dir');
 await assert.rejects(resolveContextFile(cwd, expanded.paths[0], createCollectionBudget()), /普通文件/);
});

test('binary and invalid text encoding directory files fail whole collection with the actual path', async t => {
 const cwd = await workspace(t), row = await repo(cwd);
 for (const [name, bytes, pattern] of [['binary', Buffer.from([0,1]), /二进制/],['legacy', Buffer.from([0x81]), /UTF-8/],['binary-tail', Buffer.concat([Buffer.alloc(256*1024,65), Buffer.from([0])]), /二进制/],['legacy-tail', Buffer.concat([Buffer.alloc(256*1024,65), Buffer.from([0x81])]), /UTF-8/]]) {
  await file(cwd, name + '/bad.cpp', bytes);
  await file(cwd, name + '/a-good.cpp', 'good');
  await assert.rejects(collect(cwd, {repositories:[row],contextPaths:[name]}), error => pattern.test(error.message) && error.message.includes(name + '/bad.cpp'));
 }
});

test('expanded workspace and fixed version files exceed 20 files without expanding historical directories', async t => {
 const cwd = await workspace(t), row = await repo(cwd);
 for (let i = 0; i < 19; i++) await file(cwd, 'context/' + String(i).padStart(2,'0') + '.cpp');
 const versionContexts = [{repository:'repo',side:'A',path:'historical.txt'}];
 const result = await collect(cwd, {repositories:[row],contextPaths:['context'],versionContexts});
 assert.equal(result.context.length, 20);
 assert.equal(result.context.at(-1).provenance, 'version-A');
 assert.equal(result.context.at(-1).text, 'pinned');
 await file(cwd, 'context/extra.cpp');
 assert.equal((await collect(cwd, {repositories:[row],contextPaths:['context'],versionContexts})).context.length, 21);
 await assert.rejects(collect(cwd, {repositories:[row],versionContexts:[{repository:'repo',side:'A',path:'.'}]}), /仓库相对文件路径/);
 const ac = new AbortController();
 await assert.rejects(collect(cwd, {repositories:[row],contextPaths:['context']}, ac.signal, () => ac.abort(new Error('cancel-progress'))), /cancel-progress/);
});

test('large directory scan emits cancellable live progress and aggregates empty-directory limitations', async t => {
 const cwd = await workspace(t);
 for (let i = 0; i < 1000; i++) await mkdir(path.join(cwd, 'tree', String(i)), {recursive:true});
 const progress = [];
 const result = await expand(cwd, ['tree'], {onProgress:value => progress.push(value)});
 assert.deepEqual(result.paths, []);
 assert.equal(result.limitations.length, 1);
 assert.match(result.limitations[0], /1001 个目录为 0 个/);
 assert.match(result.limitations[0], /示例不是完整目录清单/);
 assert.ok(result.limitations[0].length < 600);
 assert.ok(progress.length >= 3);
 assert.ok(progress.every(value => value.phase === 'collecting' && value.total === 0 && value.completed === 0));
 const ac = new AbortController();let calls = 0;
 await assert.rejects(expandContextPaths(cwd, ['tree'], createCollectionBudget({signal:ac.signal}), {onProgress:() => {calls++;ac.abort(new Error('cancel-live-scan'));}}), /cancel-live-scan/);
 assert.equal(calls, 1);
});

test('queued directories are revalidated before opening after a late junction replacement', async t => {
 const cwd = await workspace(t);
 await file(cwd, 'tree/nested/good.cpp', 'safe');
 await file(cwd, 'credentials/private', 'secret');
 const probe = await opendir(path.join(cwd, 'tree'));
 const prototype = Object.getPrototypeOf(probe);await probe.close();
 const originalRead = prototype.read;let swapped = false;
 const mock = t.mock.method(prototype, 'read', async function(...args) {
  const child = await originalRead.apply(this, args);
  if (!child && !swapped) {
   swapped = true;
   await rename(path.join(cwd, 'tree/nested'), path.join(cwd, 'old-nested'));
   await symlink(path.join(cwd, 'credentials'), path.join(cwd, 'tree/nested'), process.platform === 'win32' ? 'junction' : 'dir');
  }
  return child;
 });
 try {
  const result = await expand(cwd, ['tree']);
  assert.equal(swapped, true);
  assert.deepEqual(result.paths, []);
  assert.match(result.limitations.join('\n'), /junction/);
 } finally { mock.mock.restore(); }
});
