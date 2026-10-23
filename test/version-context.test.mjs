import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {collect, listRefs} from '../src/collect.mjs';
import {run} from '../src/process.mjs';

async function workspace(t) {
 const cwd = await mkdtemp(path.join(os.tmpdir(), 'report-version-context-'));
 t.after(() => rm(cwd, {recursive:true, force:true}));
 return cwd;
}
async function repository(cwd, name) {
 const root = path.join(cwd, name);
 await mkdir(root);
 const git = args => run('git', args, {cwd:root});
 await git(['init', '-b', 'main']);
 await git(['config', 'user.name', 'Fixture']);
 await git(['config', 'user.email', 'fixture@example.invalid']);
 await writeFile(path.join(root, 'api.txt'), name + '-old\n');
 await writeFile(path.join(root, 'removed.txt'), 'deleted history\n');
 await writeFile(path.join(root, '-literal[1].txt'), 'literal content\n');
 await git(['add', '.']);
 await git(['commit', '-m', 'baseline']);
 const a = (await git(['rev-parse', 'HEAD'])).trim();
 await writeFile(path.join(root, 'api.txt'), name + '-new\n');
 await git(['rm', 'removed.txt']);
 await git(['commit', '-am', 'target']);
 const b = (await git(['rev-parse', 'HEAD'])).trim();
 return {root, git, row:{path:name, type:'git', a, b}};
}
const context = (repository, side, path = 'api.txt') => ({repository, side, path});

test('Git A/B contexts use pinned objects, distinguish repositories, and never use dirty files', async t => {
 const cwd = await workspace(t);
 const one = await repository(cwd, 'one');
 const two = await repository(cwd, 'two');
 await writeFile(path.join(one.root, 'api.txt'), 'DIRTY');
 const versionContexts = [context('one','A'), context('one','B'), context('two','A'), context('one','A','removed.txt'), context('one','A','-literal[1].txt')];
 const snapshot = await collect(cwd, {repositories:[one.row, two.row], versionContexts, contextPaths:['one/api.txt']});
 assert.equal(snapshot.context[0].provenance, 'current-workspace');
 assert.equal(snapshot.context[0].text, 'DIRTY');
 assert.deepEqual(snapshot.context.slice(1).map(item => item.text), ['one-old\n','one-new\n','two-old\n','deleted history\n','literal content\n']);
 assert.equal(snapshot.context[1].revision, one.row.a);
 assert.equal(snapshot.context[2].revision, one.row.b);
 assert.equal(snapshot.context[1].repository, 'one');
 assert.equal(snapshot.context[1].provenance, 'version-A');
 assert.equal(snapshot.context[2].provenance, 'version-B');
 for (const item of snapshot.context) assert.equal(item.hash, createHash('sha256').update(item.text).digest('hex'));
 await assert.rejects(collect(cwd, {repositories:[one.row], versionContexts:[context('one','B','removed.txt')]}), /不存在或不是普通文件/);
});

test('version context rejects invalid selection, traversal, internals, and combined count overflow before I/O', async () => {
 const row = {path:'.', type:'git', a:'main', b:'main'};
 for (const entry of [context('other','A'), context('.','C'), context('.','A','../file'), context('.','A','.env'), context('.','A','.git/config'), context('.','A','dir/../file'), context('.','A','dir\\file'), context('.','A','/absolute')]) {
  await assert.rejects(collect('missing-workspace', {repositories:[row], versionContexts:[entry]}));
 }
 await assert.rejects(collect('missing-workspace', {repositories:[row], contextPaths:Array(20).fill('a.txt'), versionContexts:[context('.','A')]}), /20/);
});

test('Git historical binary, oversize, invalid UTF-8, and symlink objects fail closed', async t => {
 const cwd = await workspace(t);
 const repo = await repository(cwd, 'one');
 await writeFile(path.join(repo.root, 'binary.bin'), Buffer.from([0,1,2]));
 await writeFile(path.join(repo.root, 'legacy.txt'), Buffer.from([0xd6,0xd0]));
 await writeFile(path.join(repo.root, 'huge.txt'), 'x'.repeat(128 * 1024 + 1));
 await repo.git(['add', '.']);
 // Construct a tracked symlink independently of Windows symlink privileges.
 const target = (await repo.git(['hash-object', 'api.txt'])).trim();
 await repo.git(['update-index', '--add', '--cacheinfo', '120000,' + target + ',link.txt']);
 await repo.git(['commit', '-m', 'unsafe contexts']);
 const b = (await repo.git(['rev-parse', 'HEAD'])).trim();
 const row = {...repo.row, a:b, b};
 for (const [name, pattern] of [['binary.bin',/二进制/], ['legacy.txt',/UTF-8/], ['huge.txt',/128 KiB/], ['link.txt',/普通文件/]]) {
  await assert.rejects(collect(cwd, {repositories:[row], versionContexts:[context('one','B',name)]}), pattern);
 }
});

test('local refs listing includes full branch/tag/tracking names without contacting remotes', async t => {
 const cwd = await workspace(t);
 const repo = await repository(cwd, 'one');
 await repo.git(['tag','release']);
 await repo.git(['branch','release']);
 await repo.git(['update-ref','refs/remotes/origin/release',repo.row.b]);
 await repo.git(['remote','add','origin','https://network-must-not-be-used.invalid/repo']);
 const refs = await listRefs(cwd, 'one');
 assert.ok(refs.includes('refs/heads/main'));
 assert.ok(refs.includes('refs/heads/release'));
 assert.ok(refs.includes('refs/tags/release'));
 assert.ok(refs.includes('refs/remotes/origin/release'));
 assert.deepEqual(refs, [...refs].sort());
 await mkdir(path.join(repo.root, 'sub'));
 await assert.rejects(listRefs(cwd, 'one/sub'), /根目录/);
 await assert.rejects(listRefs(cwd, '../outside'));
 const ac = new AbortController();ac.abort();
 await assert.rejects(listRefs(cwd, 'one', ac.signal));
});

test('SVN version contexts use fixed URL/revision, preserve deleted history, and require authorization', async t => {
 const cwd = await workspace(t);
 await run('svnadmin', ['create', path.join(cwd, 'store')], {cwd});
 const url = pathToFileURL(path.join(cwd, 'store')).href;
 const root = path.join(cwd, 'wc');
 await run('svn', ['checkout', url, root, '--non-interactive'], {cwd});
 const svn = args => run('svn', args, {cwd:root}).catch(error => { error.message = 'fixture ' + args[0] + ': ' + error.message; throw error; });
 await writeFile(path.join(root, 'api.txt'), 'svn-old\n');
 await writeFile(path.join(root, 'removed.txt'), 'svn-deleted\n');
 await writeFile(path.join(root, 'api @.txt'), 'svn-unicode\n');
 await svn(['add','--quiet','api.txt','removed.txt','--','api @.txt@']);
 await svn(['commit','-m','baseline','--non-interactive']);
 await writeFile(path.join(root, 'api.txt'), 'svn-new\n');
 await svn(['delete','removed.txt']);
 await svn(['commit','-m','target','--non-interactive']);
 await writeFile(path.join(root, 'api.txt'), 'DIRTY');
 const row = {path:'wc',type:'svn',branchA:'.',branchB:'.',a:'r1',b:'r2'};
 const request = {repositories:[row], versionContexts:[context('wc','A'),context('wc','B'),context('wc','A','removed.txt'),context('wc','B','api @.txt')]};
 await assert.rejects(collect(cwd, request), /授权/);
 const snapshot = await collect(cwd, {...request,allowSvnNetwork:true});
 assert.deepEqual(snapshot.context.map(item => item.text), ['svn-old\n','svn-new\n','svn-deleted\n','svn-unicode\n']);
 assert.deepEqual(snapshot.context.map(item => item.revision), ['1','2','1','2']);
 await assert.rejects(collect(cwd, {...request,allowSvnNetwork:true,versionContexts:[context('wc','B','removed.txt')]}));
 // Unix SVN reads special files through readlink; Windows stores their link representation.
 if (process.platform === 'win32') await writeFile(path.join(root, 'link.txt'), 'link api.txt');
 else await symlink('api.txt', path.join(root, 'link.txt'));
 await svn(['add','--quiet','link.txt']);
 if (process.platform === 'win32') await svn(['propset','--quiet','svn:special','yes','link.txt']);
 await svn(['commit','--quiet','-m','special','--non-interactive']);
 const specialRow = {...row,a:'r3',b:'r3'};
 await assert.rejects(collect(cwd, {repositories:[specialRow],allowSvnNetwork:true,versionContexts:[context('wc','B','link.txt')]}), /符号链接/);
});
