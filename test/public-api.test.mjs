import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {parsePublicApiPaths, normalizePublicApiPaths, isPublicApiEvidence} from '../src/public-api.mjs';
import {collect} from '../src/collect.mjs';
import {run} from '../src/process.mjs';
const repositories = [{path:'repo',enabled:true}, {path:'.',enabled:true}, {path:'disabled',enabled:false}];
test('public boundary UI parsing normalizes separators, trims fields, deduplicates and keeps directory marker', () => {
 assert.deepEqual(parsePublicApiPaths(' repo | include\\api.h \r\nrepo|public/\nrepo|public/\n. | SDK/公开.h\n', repositories), [
  {repository:'repo',path:'include/api.h'}, {repository:'repo',path:'public/'}, {repository:'.',path:'SDK/公开.h'}
 ]);
 assert.deepEqual(parsePublicApiPaths('', repositories), []);
 assert.deepEqual(normalizePublicApiPaths([{repository:'group\\repo',path:'sdk\\'}],[{path:'group/repo'}]),[{repository:'group/repo',path:'sdk/'}]);
});
test('public declarations reject unselected and empty projects, unsafe paths, glob and malformed entries', () => {
 for (const repository of ['', ' ', 'unknown', 'disabled', '/repo', 'C:/repo', '../repo', 'repo/../repo', '.git']) {
  assert.throws(() => normalizePublicApiPaths([{repository,path:'api.h'}],repositories), /公开 API/);
 }
 for (const name of ['', '.', './', '../api.h', 'a/../api.h', '/api.h', 'C:\\api.h', '\\\\server/api.h', 'a//api.h', './api.h', 'a/./api.h', 'a/**', 'a/*.h', 'a/[ab].h', 'a/{b,c}.h', '.env', '.git/config', 'sdk/.svn/entries', 'sdk/id_rsa', 'sdk/credentials/token', 'sdk/test.pem', 'sdk/test.pem/', 'sdk\\..\\api.h', 'a\x00.h']) {
  assert.throws(() => normalizePublicApiPaths([{repository:'repo',path:name}],repositories), /公开 API/, name);
 }
 for (const value of [null, {}, 'repo|api.h', [null], [{repository:'repo'}]]) assert.throws(() => normalizePublicApiPaths(value,repositories));
 for (const text of [42, 'repo', 'repo|api.h|extra', '|api.h', 'repo|']) assert.throws(() => parsePublicApiPaths(text,repositories));
});
test('evidence matching is repository-qualified literal and segment-bounded, without include/public inference', () => {
 const paths = parsePublicApiPaths('repo|sdk/\nrepo|include/api.h',repositories);
 const matches = (file, repository='repo') => isPublicApiEvidence({repository,file},paths);
 assert.equal(matches('sdk/nested/api.h'),true);
 assert.equal(matches('sdk\\api.h'),true);
 assert.equal(matches('include/api.h'),true);
 for (const file of ['sdk', 'sdk/', 'sdk-other/api.h', 'include/api.hpp', 'include/api.h/child', 'public/api.h', 'include/other.h', 'sdk/../private.h', 'sdk/.git/config', 'sdk/.env', 'sdk/key.pem', '/sdk/api.h']) assert.equal(matches(file),false,file);
 assert.equal(matches('sdk/api.h','other'),false);
 assert.equal(matches('SDK/api.h'),false);
 assert.equal(isPublicApiEvidence({repository:'repo',path:'sdk/api.h'},paths),true);
 assert.equal(isPublicApiEvidence({file:'sdk/api.h'},paths),false);
 assert.equal(isPublicApiEvidence({repository:'repo',file:'include/api.h'},[]),false);
});
test('collection rejects malformed public boundaries before accessing the workspace', async () => {
 const request = {repositories:[{path:'repo',type:'git',a:'HEAD',b:'HEAD'}]};
 for (const publicApiPaths of [null, {}, 'repo|api.h', [{repository:'other',path:'api.h'}], [{repository:'repo',path:'../api.h'}]]) await assert.rejects(collect('not-an-existing-workspace',{...request,publicApiPaths}),/公开 API/);
});
test('collection persists only explicit normalized candidate declarations and leaves legacy snapshot shape unchanged', async t => {
 const cwd = await mkdtemp(path.join(tmpdir(),'report-public-api-'));
 t.after(() => rm(cwd,{recursive:true,force:true}));
 const root = path.join(cwd,'repo'); await mkdir(root);
 const git = args => run('git',args,{cwd:root});
 await git(['init']); await git(['config','user.name','Fixture']); await git(['config','user.email','fixture@example.invalid']);
 await writeFile(path.join(root,'api.h'),'void api();\n'); await git(['add','.']); await git(['commit','-m','base']);
 const request = {repositories:[{path:'repo',type:'git',gitMode:'local',a:'HEAD',b:'HEAD'}]};
 const legacy = await collect(cwd,request);
 assert.equal(Object.hasOwn(legacy,'publicApiPaths'),false);
 assert.equal(legacy.limitations.some(x => x.includes('操作者声明')),false);
 const snapshot = await collect(cwd,{...request,publicApiPaths:[{repository:'repo',path:' sdk\\public/ '}]});
 assert.deepEqual(snapshot.publicApiPaths,[{repository:'repo',path:'sdk/public/'}]);
 assert.ok(snapshot.limitations.some(x => /操作者声明.*不是历史发布.*契约/.test(x)));
 assert.deepEqual(Object.keys(snapshot).filter(x => x !== 'publicApiPaths'),Object.keys(legacy));
 const empty = await collect(cwd,{...request,publicApiPaths:[]});
 assert.deepEqual(empty.publicApiPaths,[]);
});
