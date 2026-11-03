import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, open} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createCollectionBudget} from '../src/budget.mjs';
import {collect} from '../src/collect.mjs';
import {run} from '../src/process.mjs';
import {markdown} from '../src/report.mjs';

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
   const budget = createCollectionBudget({maxBytes:max});
   // JSON string quotes consume two bytes; include multibyte UTF-8, not character counting.
   const value = '中' + 'x'.repeat(max + delta - 5);
   assert.equal(Buffer.byteLength(JSON.stringify(value)), max + delta);
   if (delta > 0) assert.throws(() => budget.checkpoint(value), /未静默截断/);
   else assert.equal(budget.checkpoint(value), max + delta);
  }
 }
 for (const value of [undefined, false, true, 'true', 1]) {
  const budget = createCollectionBudget({allowBatches:value, now:() => Number.MAX_SAFE_INTEGER});
  assert.equal(budget.maxBytes, undefined);
  assert.equal(budget.commandTimeout(), undefined);
  budget.assertAdditional(9 * MIB);
  // Unlimited checkpoints must not stringify the entire accumulated snapshot repeatedly.
  budget.checkpoint({toJSON(){throw new Error('unexpected serialization');}});
 }
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
 const budget = createCollectionBudget({maxBytes:MIB});
 budget.checkpoint('x'.repeat(MIB - 12));
 budget.assertAdditional(10);
 assert.throws(() => budget.assertAdditional(11), /bytes 上限/);
});

test('cancel before the first context or after one file never reads the next file', async t => {
 const {cwd, row} = await fixture(t);
 await writeFile(path.join(cwd, 'first.txt'), 'source');
 // Expansion validates all metadata up front; spy on body reads, not missing metadata.
 await writeFile(path.join(cwd, 'second.txt'), 'must not be read');
 const probe = await open(path.join(cwd, 'first.txt'), 'r');
 const prototype = Object.getPrototypeOf(probe);await probe.close();
 const originalRead = prototype.read;
 for (const trigger of ['项目差异已采集', '源码已采集']) {
  const ac = new AbortController();let readsAfterAbort = 0, bytesRead = 0;
  const readMock = t.mock.method(prototype, 'read', async function(...args) {
   if (ac.signal.aborted) readsAfterAbort++;
   const result = await originalRead.apply(this, args);bytesRead += result.bytesRead;return result;
  });
  try {
   const request = {repositories:[row], contextPaths:['first.txt', 'second.txt']};
   await assert.rejects(collect(cwd, request, ac.signal, progress => {
    if (progress.label.startsWith(trigger)) ac.abort(new Error('fixture-cancelled'));
   }), /fixture-cancelled/);
   assert.equal(readsAfterAbort, 0);
   assert.equal(bytesRead, trigger === '源码已采集' ? Buffer.byteLength('source') : 0);
  } finally { readMock.mock.restore(); }
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

test('source contexts above 20 files, 128 KiB each and 8 MiB total collect without a scale flag', async t => {
 const {cwd, row} = await fixture(t);
 const contextPaths = [];
 for (let i = 0; i < 33; i++) {
  const name = 'context-' + i + '.txt';
  await writeFile(path.join(cwd, name), 'x'.repeat(256 * 1024 + 1));
  contextPaths.push(name);
 }
 const request = {repositories:[row], contextPaths};
 const snapshot = await collect(cwd, request);
 assert.equal(snapshot.context.length, 33);
 assert.ok(snapshot.context.every(item => item.text.length === 256 * 1024 + 1));
 assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > 8 * MIB);
 const report = markdown(snapshot);
 for (const name of contextPaths) assert.ok(report.includes(name), name);
 assert.equal((report.match(/当前工作区快照；编码 utf-8；原始字节 SHA-256/g) || []).length, 33);
});

test('live command abort and remaining deadline stop active children before settling', async () => {
 const ac = new AbortController();
 await assert.rejects(run(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(()=>{},1000)'], {
  signal:ac.signal, onStdoutBytes:() => ac.abort(),
 }), error => error.name === 'AbortError');
 await assert.rejects(run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {timeoutMs:30}), /命令超时/);
 await assert.rejects(run(process.execPath, ['-e', 'process.stdout.write("abcdef")'], {onStdoutBytes:() => {throw new Error('aggregate-limit');}}), /aggregate-limit/);
 const script = 'process.stdout.write(Buffer.alloc(4*1024*1024+1,120))';
 assert.equal((await run(process.execPath, ['-e', script])).length, 4*MIB+1);
 assert.equal((await run(process.execPath, ['-e', script], {maxBytes:8*MIB})).length, 4*MIB+1);
 await assert.rejects(run(process.execPath, ['-e', script], {maxBytes:4*MIB}), /上限/);
});

test('large Git diff passes full collection without a hidden 4 MiB clamp', async t => {
 const {cwd, root, git, row} = await fixture(t);
 const text = 'release-content-0123456789'.repeat(190000) + '\n';
 await writeFile(path.join(root, 'large.txt'), text);
 await git(['add', '.']); await git(['commit', '-m', 'large release']);
 const snapshot = await collect(cwd, {repositories:[{...row,b:'HEAD'}]});
 const repo = snapshot.repositories[0];
 assert.ok(Buffer.byteLength(repo.diff) > 4 * MIB);
 assert.ok(repo.diff.includes('+' + text.trimEnd()));
 assert.deepEqual(repo.files, ['large.txt']);
});

test('runner drains large stderr and retains only diagnostic prefix without limiting stdout', async () => {
 assert.equal(await run(process.execPath, ['-e', 'process.stderr.write(Buffer.alloc(9*1024*1024,120));process.stdout.write("complete")']), 'complete');
 await assert.rejects(run(process.execPath, ['-e', 'process.stderr.write("diagnostic-prefix"+"x".repeat(9*1024*1024),()=>process.exit(2))']), error => error.message.includes('diagnostic-prefix') && error.message.length < 2000);
});

test('runner cancellation waits for actual child exit before settling', async t => {
 const {cwd} = await fixture(t);
 const marker = path.join(cwd, 'child-pid');
 const ac = new AbortController();
 await assert.rejects(run(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1],String(process.pid));process.stdout.write("ready");setInterval(()=>{},1000)', marker], {
  signal:ac.signal,onStdoutBytes:() => ac.abort(),
 }), error => error.name === 'AbortError');
 const pid = Number(await readFile(marker, 'utf8'));
 assert.ok(Number.isInteger(pid) && pid > 0);
 assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
});

test('runner has no default timer and honors explicit time budgets above the former 60 second cap', async t => {
 const delays = [];
 const original = globalThis.setTimeout;
 const mock = t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
  delays.push(delay);return original(callback, delay, ...args);
 });
 try {
  assert.equal(await run(process.execPath, ['-e', 'process.stdout.write("ok")']), 'ok');
  assert.deepEqual(delays, []);
  assert.equal(await run(process.execPath, ['-e', 'process.stdout.write("ok")'], {timeoutMs:120000}), 'ok');
  assert.equal(delays.length, 1);
  assert.ok(delays[0] > 60000 && delays[0] <= 120000);
  let clock = 0;
  const budget = createCollectionBudget({timeoutMs:300000, now:() => clock});
  assert.equal(budget.commandTimeout(), 300000);
  clock = 250000;
  assert.equal(budget.commandTimeout(), 50000);
 } finally { mock.mock.restore(); }
});
