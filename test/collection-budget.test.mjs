import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, open} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createCollectionBudget} from '../src/budget.mjs';
import {collect} from '../src/collect.mjs';
import {run} from '../src/process.mjs';

const MIB = 1024 * 1024;
async function fixture(t) {
 const cwd = await mkdtemp(path.join(os.tmpdir(), 'report-budget-'));
 t.after(() => rm(cwd, {recursive:true, force:true}));
 const root = path.join(cwd, 'repo');
 await mkdir(root);
 const git = args => run('git', args, {cwd:root});
 await git(['init']);
 await git(['config', 'user.name', 'Fixture']);
 await git(['config', 'user.email', 'fixture@example.invalid']);
 await writeFile(path.join(root, 'api.txt'), 'base\n');
 await git(['add', '.']);
 await git(['commit', '-m', 'base']);
 const a = (await git(['rev-parse', 'HEAD'])).trim();
 return {cwd, root, git, row:{path:'repo', type:'git', a, b:a}};
}

test('JSON evidence limits are exact bytes at limit -1, limit, limit +1', () => {
 for (const max of [MIB, 8 * MIB]) {
  for (const delta of [-1, 0, 1]) {
   const budget = createCollectionBudget({allowBatches:max === 8 * MIB});
   // JSON string quotes consume two bytes; include multibyte UTF-8, not character counting.
   const value = '中' + 'x'.repeat(max + delta - 5);
   assert.equal(Buffer.byteLength(JSON.stringify(value)), max + delta);
   if (delta > 0) assert.throws(() => budget.checkpoint(value), /未静默截断/);
   else assert.equal(budget.checkpoint(value), max + delta);
  }
 }
 for (const value of [undefined, false, 'true', 1]) assert.equal(createCollectionBudget({allowBatches:value}).maxBytes, MIB);
});

test('shared monotonic deadline is not reset by command preparation or checkpoints', () => {
 let clock = 0;
 const budget = createCollectionBudget({now:() => clock, timeoutMs:100});
 assert.equal(budget.commandTimeout(), 100);
 clock = 60;
 budget.checkpoint({});
 assert.equal(budget.commandTimeout(), 40);
 clock = 100;
 assert.throws(() => budget.commandTimeout(), /总时间/);
 assert.throws(() => budget.checkpoint({}), /总时间/);
});

test('additional command bytes share previously accumulated evidence budget', () => {
 const budget = createCollectionBudget();
 budget.checkpoint('x'.repeat(MIB - 12));
 budget.assertAdditional(10);
 assert.throws(() => budget.assertAdditional(11), /1 MiB/);
});

test('cancel before the first context or after one file never reads the next file', async t => {
 const {cwd, row} = await fixture(t);
 await writeFile(path.join(cwd, 'first.txt'), 'source');
 for (const trigger of ['项目差异已采集', '源码已采集']) {
  const ac = new AbortController();
  const request = {repositories:[row], contextPaths:['first.txt', 'missing.txt']};
  await assert.rejects(collect(cwd, request, ac.signal, progress => {
   if (progress.label.startsWith(trigger)) ac.abort(new Error('fixture-cancelled'));
  }), /fixture-cancelled/);
 }
});

test('cancellation during an open source read closes the file and rejects the snapshot', async t => {
 const {cwd, row} = await fixture(t);
 const file = path.join(cwd, 'context.txt');
 await writeFile(file, 'x'.repeat(40000));
 const probe = await open(file, 'r');
 const prototype = Object.getPrototypeOf(probe);
 await probe.close();
 const ac = new AbortController();
 const originalRead = prototype.read;
 let capturedHandle;
 const readMock = t.mock.method(prototype, 'read', async function(...args) {
  capturedHandle = this;
  const value = await originalRead.apply(this, args);
  ac.abort(new Error('during-read'));
  return value;
 });
 try {
  await assert.rejects(collect(cwd, {repositories:[row], contextPaths:['context.txt']}, ac.signal), /during-read/);
  assert.ok(capturedHandle);
  assert.equal(capturedHandle.fd, -1);
  await assert.rejects(originalRead.call(capturedHandle, Buffer.alloc(1), 0, 1, null), /closed/);
 } finally { readMock.mock.restore(); }
});

test('accumulated source contexts require explicit batch consent above 1 MiB', async t => {
 const {cwd, row} = await fixture(t);
 const contextPaths = [];
 for (let i = 0; i < 9; i++) {
  const name = 'context-' + i + '.txt';
  await writeFile(path.join(cwd, name), 'x'.repeat(128 * 1024));
  contextPaths.push(name);
 }
 const request = {repositories:[row], contextPaths};
 await assert.rejects(collect(cwd, request), /1 MiB/);
 await assert.rejects(collect(cwd, {...request, allowBatches:'true'}), /1 MiB/);
 const snapshot = await collect(cwd, {...request, allowBatches:true});
 assert.equal(snapshot.context.length, 9);
 assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > MIB);
});

test('live command abort and remaining deadline stop active children before settling', async () => {
 const ac = new AbortController();
 await assert.rejects(run(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(()=>{},1000)'], {
  signal:ac.signal, onStdoutBytes:() => ac.abort(),
 }), error => error.name === 'AbortError');
 await assert.rejects(run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {timeoutMs:30}), /命令超时/);
 await assert.rejects(run(process.execPath, ['-e', 'process.stdout.write("abcdef")'], {onStdoutBytes:() => {throw new Error('aggregate-limit');}}), /aggregate-limit/);
 await assert.rejects(run(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(4*1024*1024+1,120))'], {maxBytes:8*MIB}), /上限/);
});
