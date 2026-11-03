import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat} from 'node:fs/promises';
import {run, runGitRead} from '../src/process.mjs';
import {withRemoteRepository, listRemoteRefs, normalizeRemoteRef} from '../src/git-remote.mjs';

async function filesState(root) {
  const result = [], pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) result.push([path.relative(root, target), createHash('sha256').update(await readFile(target)).digest('hex'), (await stat(target)).mtimeMs]);
    }
  }
  return result.sort((a, b) => a[0].localeCompare(b[0]));
}

async function fixture(t, format = 'sha1') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'git-remote-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const seed = path.join(directory, 'seed'), remote = path.join(directory, '远端 space.git'), local = path.join(directory, 'local');
  await mkdir(seed);
  const git = args => run('git', args, {cwd: seed});
  await git(['init', '-b', 'main', '--object-format=' + format]);
  await git(['config', 'user.name', 'Fixture']); await git(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(seed, 'api.txt'), 'base\n'); await git(['add', '.']); await git(['commit', '-m', 'base']);
  const base = (await git(['rev-parse', 'HEAD'])).trim();
  await git(['clone', '--bare', seed, remote]);
  await git(['clone', '--no-local', remote, local]);
  await writeFile(path.join(seed, 'api.txt'), 'remote-new\n'); await git(['commit', '-am', 'new remote']);
  const current = (await git(['rev-parse', 'HEAD'])).trim();
  await git(['branch', 'develop']); await git(['branch', '中文分支']);
  await git(['tag', '-a', '发布版本', '-m', 'annotated']);
  await git(['push', remote, '--all']); await git(['push', remote, '--tags']);
  await run('git', ['symbolic-ref', 'HEAD', 'refs/heads/develop'], {cwd: remote});
  await writeFile(path.join(local, 'api.txt'), 'dirty local must survive\n');
  return {directory, seed, remote, local, git, base, current};
}

const read = (directory, args) => runGitRead(args, {cwd: directory});

test('normalization strips only the selected remote prefix and preserves Git revision expressions', () => {
  for (const [input, expected] of [['origin/develop', 'refs/heads/develop'], ['refs/remotes/origin/main~1', 'refs/heads/main~1'], ['origin/中文', 'refs/heads/中文'], ['other/main', 'other/main'], ['main', 'main'], ['HEAD~1', 'HEAD~1'], ['refs/tags/v1', 'refs/tags/v1'], ['a'.repeat(40), 'a'.repeat(40)]]) {
    assert.equal(normalizeRemoteRef(input, 'origin'), expected);
  }
  assert.equal(normalizeRemoteRef('_custom/main', '_custom'), 'refs/heads/main');
  for (const remote of ['', '-option', 'https://host/path', 'ext::evil', 'a/b', 'a b', 'origin\n', 'origin\0']) assert.throws(() => normalizeRemoteRef('HEAD', remote), /配置名称/);
  for (const ref of ['', '--upload-pack=evil', 'HEAD\n', 'has space']) assert.throws(() => normalizeRemoteRef(ref), /无效/);
});

test('fresh refs and full remote history ignore stale local refs and preserve every business file', async t => {
  const f = await fixture(t), before = await filesState(f.local);
  assert.equal((await read(f.local, ['rev-parse', 'origin/main'])).trim(), f.base);
  const refs = await listRemoteRefs(f.local);
  assert.deepEqual(refs, ['refs/heads/develop', 'refs/heads/main', 'refs/heads/中文分支', 'refs/tags/发布版本'].sort());
  assert.ok(!refs.some(ref => ref.endsWith('^{}')));
  let temporary;
  const result = await withRemoteRepository(f.local, {}, async (root, info) => {
    temporary = root;
    assert.equal((await read(root, ['rev-parse', '--is-bare-repository'])).trim(), 'true');
    assert.equal((await read(root, ['rev-parse', 'HEAD'])).trim(), f.current);
    assert.equal((await read(root, ['symbolic-ref', 'HEAD'])).trim(), 'refs/heads/develop');
    assert.equal((await read(root, ['rev-parse', 'HEAD~1'])).trim(), f.base);
    assert.equal((await read(root, ['rev-parse', f.base + '^{commit}'])).trim(), f.base);
    assert.equal((await read(root, ['rev-parse', normalizeRemoteRef('origin/main') + '^{commit}'])).trim(), f.current);
    assert.equal((await read(root, ['rev-parse', 'refs/tags/发布版本^{commit}'])).trim(), f.current);
    assert.equal(await read(root, ['show', f.base + ':api.txt']), 'base\n');
    await assert.rejects(read(root, ['rev-parse', '--verify', '--end-of-options', 'missing-branch^{commit}']));
    await assert.rejects(stat(path.join(root, 'shallow')), error => error.code === 'ENOENT');
    assert.deepEqual(Object.keys(info).sort(), ['observedAt', 'remote', 'source']);
    assert.equal(info.remote, 'origin'); assert.equal(info.source, 'remote'); assert.ok(Number.isFinite(Date.parse(info.observedAt)));
    assert.ok(!JSON.stringify(info).includes(f.remote));
    return 'done';
  });
  assert.equal(result, 'done');
  await assert.rejects(stat(temporary), error => error.code === 'ENOENT');
  assert.deepEqual(await filesState(f.local), before);
});

test('configured file URL, relative paths and selected remote name resolve in the source root', async t => {
  const f = await fixture(t);
  await run('git', ['config', 'remote.backup.url', pathToFileURL(f.remote).href], {cwd: f.local});
  assert.ok((await listRemoteRefs(f.local, {remote: 'backup'})).includes('refs/heads/中文分支'));
  await run('git', ['config', 'remote.relative.url', path.relative(f.local, f.remote)], {cwd: f.local});
  await withRemoteRepository(f.local, {remote: 'relative'}, async root => assert.equal((await read(root, ['rev-parse', 'main'])).trim(), f.current));
});

test('callback failure and cancellation preserve identity and always clean temporary files', async t => {
  const f = await fixture(t); let temporary;
  const expected = new Error('caller failure');
  await assert.rejects(withRemoteRepository(f.local, {}, async root => {temporary = root; throw expected;}), error => error === expected);
  await assert.rejects(stat(temporary), error => error.code === 'ENOENT');
  const controller = new AbortController(), reason = new Error('cancelled exactly');
  await assert.rejects(withRemoteRepository(f.local, {signal: controller.signal}, async root => {temporary = root; controller.abort(reason); controller.signal.throwIfAborted();}), error => error === reason);
  await assert.rejects(stat(temporary), error => error.code === 'ENOENT');
  const pre = new AbortController(); pre.abort(reason);
  await assert.rejects(listRemoteRefs(f.local, {signal: pre.signal}), error => error === reason);
});

test('unsafe URLs, multiple URLs, missing remotes and nested roots fail without disclosing secrets', async t => {
  const f = await fixture(t);
  for (const address of ['ext::sh -c secret-token', 'helper::secret-token', 'ftp://private-user:secret-token@host/path', '--upload-pack=secret-token', 'bad:scheme:secret-token\n']) {
    await run('git', ['config', '--replace-all', 'remote.bad.url', address], {cwd: f.local});
    await assert.rejects(listRemoteRefs(f.local, {remote: 'bad'}), error => error.code === 'code-report/git-remote' && !error.message.includes('secret-token') && !error.message.includes(address));
  }
  await run('git', ['config', 'remote.missing.url', path.join(f.directory, 'private-secret-missing.git')], {cwd: f.local});
  await assert.rejects(listRemoteRefs(f.local, {remote: 'missing'}), error => error.code === 'code-report/git-remote' && !error.message.includes('private-secret'));
  await run('git', ['config', '--add', 'remote.origin.url', f.remote], {cwd: f.local});
  await assert.rejects(listRemoteRefs(f.local), /读取配置失败/);
  await mkdir(path.join(f.local, 'nested'));
  await assert.rejects(listRemoteRefs(path.join(f.local, 'nested')), /读取配置失败/);
});

test('local repository URL rewrite, hooks and uploadpack configuration are not inherited', async t => {
  const f = await fixture(t);
  await run('git', ['config', 'url.ext::secret-helper.insteadOf', f.remote], {cwd: f.local});
  await run('git', ['config', 'remote.origin.uploadpack', 'not-an-executable-secret'], {cwd: f.local});
  await run('git', ['config', 'core.hooksPath', path.join(f.directory, 'nonexistent-hooks')], {cwd: f.local});
  assert.ok((await listRemoteRefs(f.local)).includes('refs/heads/main'));
  await withRemoteRepository(f.local, {}, async root => assert.equal((await read(root, ['rev-parse', 'HEAD'])).trim(), f.current));
});

test('remote without valid HEAD never falls back to init or local HEAD', async t => {
  const f = await fixture(t);
  await run('git', ['symbolic-ref', 'HEAD', 'refs/heads/not-present'], {cwd: f.remote});
  await withRemoteRepository(f.local, {}, async root => {
    assert.equal((await read(root, ['symbolic-ref', 'HEAD'])).trim(), 'refs/code-report/unavailable-head');
    await assert.rejects(read(root, ['rev-parse', '--verify', 'HEAD']));
    assert.equal((await read(root, ['rev-parse', 'main'])).trim(), f.current);
  });
});

test('linked worktree roots are valid but cancellation before remote transport never enters callback', async t => {
  const f = await fixture(t), linked = path.join(f.directory, 'linked');
  await run('git', ['worktree', 'add', '-b', 'linked-local', linked], {cwd: f.local});
  const before = await filesState(f.local);
  await withRemoteRepository(linked, {}, async root => assert.equal((await read(root, ['rev-parse', 'HEAD'])).trim(), f.current));
  const controller = new AbortController(), reason = new Error('cancel before transport'); let called = false;
  await assert.rejects(withRemoteRepository(f.local, {signal: controller.signal, onProgress() {controller.abort(reason);}}, async () => {called = true;}), error => error === reason);
  assert.equal(called, false);
  assert.deepEqual(await filesState(f.local), before);
});

test('isolated user-global authentication survives but rewrite hooks and uploadpack do not', async t => {
  const f = await fixture(t), home = path.join(f.directory, 'isolated-home');
  await mkdir(home);
  const global = path.join(home, '.gitconfig');
  const gitConfig = args => run('git', ['config', '--file', global, ...args], {cwd: f.directory});
  await gitConfig(['credential.username', 'fixture-credential-user']);
  await gitConfig(['http.userAgent', 'fixture-http-agent']);
  await gitConfig(['url.ext::forbidden-helper.insteadOf', f.remote]);
  await gitConfig(['core.hooksPath', path.join(home, 'forbidden-hooks')]);
  await gitConfig(['remote.origin.uploadpack', 'forbidden-uploadpack']);
  await gitConfig(['protocol.ext.allow', 'always']);
  const moduleURL = new URL('../src/git-remote.mjs', import.meta.url).href;
  const processURL = new URL('../src/process.mjs', import.meta.url).href;
  const script = [
    'import assert from "node:assert/strict";',
    'import {withRemoteRepository} from ' + JSON.stringify(moduleURL) + ';',
    'import {runGitRemote,runGitRead} from ' + JSON.stringify(processURL) + ';',
    'await withRemoteRepository(' + JSON.stringify(f.local) + ', {}, async root => {',
    ' const config = await runGitRemote(["config","--list"],{cwd:root});',
    ' assert.ok(config.includes("credential.username=fixture-credential-user"));',
    ' assert.ok(config.includes("http.useragent=fixture-http-agent"));',
    ' assert.ok(!config.includes("forbidden-helper"));',
    ' assert.ok(!config.includes("forbidden-hooks"));',
    ' assert.ok(!config.includes("forbidden-uploadpack"));',
    ' assert.equal((await runGitRead(["rev-parse","HEAD"],{cwd:root})).trim(),' + JSON.stringify(f.current) + ');',
    '});'
  ].join('\n');
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {cwd: f.directory, env: {...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home}, maxBuffer: 1024 * 1024});
});

test('SHA256 source and remote use matching isolated object format', async t => {
  const f = await fixture(t, 'sha256');
  await withRemoteRepository(f.local, {}, async root => {
    assert.equal((await read(root, ['rev-parse', '--show-object-format'])).trim(), 'sha256');
    assert.equal((await read(root, ['rev-parse', 'HEAD~1'])).trim(), f.base);
  });
});
