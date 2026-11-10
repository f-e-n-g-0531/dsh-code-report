import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFailureDiagnostic} from '../src/git-remote.mjs';

test('remote failures expose only fixed actionable diagnostic categories, never raw credentials', () => {
  const secret='https://private-user:private-token@secret-host/private-repo';
  const samples=[
    ['ssh-configuration','/private/config: line 1: Bad configuration option: invalidoption'],
    ['ssh-configuration',"Can't open user config file /private/config: Permission denied"],
    ['ssh-configuration','Bad owner or permissions on /private/.ssh/config'],
    ['ssh-identity','Warning: Identity file /private/keyfile not accessible: No such file or directory.'],
    ['ssh-identity','Load key /private/keyfile: invalid format'],
    ['ssh-identity','WARNING: UNPROTECTED PRIVATE KEY FILE!'],
    ['ssh-publickey','git@secret-host: Permission denied (publickey).\nfatal: Could not read from remote repository.'],
    ['ssh-publickey','No supported authentication methods available'],
    ['ssh-publickey','No more authentication methods to try.'],
    ['ssh-host-key','Host key verification failed.'],
    ['ssh-host-key','WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!'],
    ['ssh-host-key','No ED25519 host key is known for secret-host and you have requested strict checking.'],
    ['dns','ssh: Could not resolve hostname secret-host: Name or service not known'],
    ['dns','fatal: unable to access URL: Could not resolve host: secret-host'],
    ['proxy','Could not resolve proxy: secret-proxy'],
    ['proxy','fatal: unable to access URL: Received HTTP code 407 from proxy after CONNECT'],
    ['connection','ssh: connect to host secret-host port 2222: Connection refused'],
    ['connection','ssh: connect to host secret-host port 2222: Connection timed out'],
    ['connection','fatal: unable to access URL: Failed to connect to server'],
    ['connection','命令超时'],
    ['tls','fatal: unable to access URL: SSL certificate problem: unable to get local issuer certificate'],
    ['tls','schannel: next InitializeSecurityContext failed'],
    ['authentication','fatal: Authentication failed for URL'],
    ['authentication','fatal: could not read Username for URL: terminal prompts disabled'],
    ['authentication','fatal: unable to access URL: The requested URL returned error: 403'],
    ['repository','ERROR: Repository not found.'],
    ['repository','fatal: /private/repository does not appear to be a git repository'],
    ['tool','error: cannot run /private/ssh: No such file or directory'],
    ['tool','error: cannot spawn /private/ssh: No such file or directory'],
    ['tool','error: cannot run /private/ssh: No such file or directory\nfatal: Could not read from remote repository.'],
    ['unknown','fatal: unusual server error containing confidential information']
  ];
  for(const [kind,stderr] of samples){
    const diagnostic=remoteFailureDiagnostic(new Error(stderr+' '+secret));
    assert.equal(diagnostic.kind,kind,stderr);
    assert.ok(diagnostic.hint.length>10);
    for(const sensitive of ['private-user','private-token','secret-host','private-repo','secret-proxy','keyfile','confidential information'])assert.ok(!diagnostic.hint.includes(sensitive),sensitive);
    assert.deepEqual(Object.keys(diagnostic).sort(),['hint','kind']);
  }
  assert.equal(remoteFailureDiagnostic(Object.assign(new Error('spawn git ENOENT'),{code:'ENOENT'})).kind,'tool');
  for(const error of [undefined,null,{},new Error(),{message:123}])assert.equal(remoteFailureDiagnostic(error).kind,'unknown');
});
