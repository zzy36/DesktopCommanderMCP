import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorizeBlockedSshCommand, commandDigest, sshAlias } from '../dist/ssh-command-approval.js';
import { commandManager } from '../dist/command-manager.js';
import { startProcess } from '../dist/tools/improved-process-tools.js';
import { terminalManager } from '../dist/terminal-manager.js';
import { DeviceExecutor } from '../dist/remote-device/fleet/device-executor.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lcm-ssh-approval-'));
const stateDir = path.join(dir,'state');
await fs.mkdir(path.join(stateDir,'used'),{recursive:true});
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyPath = path.join(dir,'pub.pem');
await fs.writeFile(publicKeyPath,publicKey.export({format:'pem',type:'spki'}));
const command = "ssh -o BatchMode=yes tencent-xjp 'sudo -n sysctl -w net.core.rmem_max=8388608'";
const options = {hostname:'YUAN',publicKeyPath,stateDir};
const now = Date.now();
let index = 0;
const token = (overrides = {}) => {
  const obj = {
    v:1,host:'YUAN',alias:'tencent-xjp',command_sha256:commandDigest(command),
    issued_at:now-1000,expires_at:now+120000,
    nonce:(++index).toString(16).padStart(32,'0'),approved_by:'owner', ...overrides,
  };
  const payload=Buffer.from(JSON.stringify(obj));
  return payload.toString('base64url')+'.'+sign(null,payload,privateKey).toString('base64url');
};
let launched=[];
const originalExecute = terminalManager.executeCommand;
try {
  assert.equal(sshAlias(command),'tencent-xjp');
  assert.equal(commandManager.extractCommands(command)[0],'ssh',
    'upstream parser sees the local ssh program, not quoted remote sudo');
  assert.equal((await startProcess({command,timeout_ms:1000})).structuredContent.blocked,true,
    'no grant must be denied');

  // Never execute SSH from tests: stub the terminal boundary.
  terminalManager.executeCommand = async (...args) => {
    launched.push(args);
    return {pid:123456,output:'STUB_ONLY',processState:{isWaitingForInput:false,isFinished:false},isBlocked:false};
  };
  const grant = token();
  process.env.LCM_SSH_APPROVAL_PUBLIC_KEY_FILE=publicKeyPath;
  process.env.LCM_SSH_APPROVAL_STATE_DIR=stateDir;
  const result=await startProcess({command,timeout_ms:1000,command_approval:grant});
  assert.equal(result.isError,undefined,'authorized command should reach stubbed terminal');
  assert.equal(launched.length,1);
  assert.equal(launched[0][0],command);
  assert.equal((await startProcess({command,timeout_ms:1000,command_approval:grant})).structuredContent.approval_reason,'invalid_approval',
    'one-time token must not run twice');
  assert.equal(launched.length,1,'replay must not reach terminal');
  assert.equal((await authorizeBlockedSshCommand(command,token({host:'HEMA'}),options)).allowed,false);
  assert.equal((await authorizeBlockedSshCommand(command,token({alias:'another-vps'}),options)).allowed,false);
  assert.equal((await authorizeBlockedSshCommand(command,token({expires_at:now-1}),options)).allowed,false);
  assert.equal((await authorizeBlockedSshCommand(command,token({expires_at:now+3600000}),options)).allowed,false);
  assert.equal((await authorizeBlockedSshCommand(command,token({command_sha256:commandDigest(command+' ')}),options)).allowed,false);
  const forged=token(); const [payload,signature]=forged.split('.');
  const changed=payload+'.'+(signature[0]==='A'?'B':'A')+signature.slice(1);
  assert.equal((await authorizeBlockedSshCommand(command,changed,options)).allowed,false);
  for (const bad of [
    "ssh -o BatchMode=yes tencent-xjp 'sudo -n sysctl -w net.core.rmem_max=8388608'; rm -rf /",
    "ssh -o BatchMode=yes tencent-xjp 'sudo -n sysctl -w net.core.rmem_max=8388608' | cat",
    "ssh -o BatchMode=yes tencent-xjp 'sudo -n sysctl -w net.core.rmem_max=$x'",
    "ssh -o BatchMode=yes tencent-xjp 'sudo -n sysctl -w net.core.rmem_max=8388608'\nRemove-Item *",
    "sudo rm -rf /",
    "ssh -o BatchMode=yes other-host 'sudo -n sysctl -w net.core.rmem_max=8388608'",
  ]) {
    const decision=await authorizeBlockedSshCommand(bad,token(),options);
    assert.equal(decision.allowed,false,'unexpected grant: '+bad);
  }
  assert.equal((await startProcess({command:'sudo rm -rf /',timeout_ms:1000})).structuredContent.blocked,true);
  assert.equal((await startProcess({command:'sudo rm -rf /',timeout_ms:1000,command_approval:token()})).structuredContent.blocked,true);
  assert.equal(launched.length,1);

  // Independently existing external L1 execution-policy rejection remains
  // before DesktopCommander validation and cannot be bypassed by this grant.
  let dispatcherCalls=0;
  const executor=new DeviceExecutor({callClientTool:async()=>{dispatcherCalls++;return {}}},'YUAN',
    {command:process.execPath,args:['-e','process.stdout.write(JSON.stringify({allow:false,reason:"L1 denied"}))']});
  await assert.rejects(()=>executor.execute('start_process',{command,command_approval:token()}),/L1 denied/);
  assert.equal(dispatcherCalls,0);

  // Exercise the offline signer CLI end-to-end with disposable test keys.
  const privatePath=path.join(dir,'signer-private.pem');
  const commandFile=path.join(dir,'command.txt');
  const tokenFile=path.join(dir,'token.txt');
  await fs.writeFile(privatePath,privateKey.export({format:'pem',type:'pkcs8'}));
  await fs.writeFile(commandFile,command);
  const cli=spawnSync(process.execPath,[
    'scripts/sign-lcm-ssh-approval.mjs','--key',privatePath,'--host','YUAN',
    '--alias','tencent-xjp','--approved-by','owner',
    '--command-file',commandFile,'--out',tokenFile,'--ttl-seconds','180',
  ],{cwd:process.cwd(),encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);
  assert.equal((await authorizeBlockedSshCommand(command,
    (await fs.readFile(tokenFile,'utf8')).trim(),options)).allowed,true);

  const audit=(await fs.readFile(path.join(stateDir,'audit.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert(audit.some(e=>e.event==='ssh_approval_consumed' && e.host==='YUAN' && e.alias==='tencent-xjp' && e.sha256===commandDigest(command)));
  assert(!audit.some(e=>JSON.stringify(e).includes(command) || JSON.stringify(e).includes(grant)), 'audit must not leak commands/tokens');
  console.log('PASS: exact one-time signed SSH grant; replay/scope/injection/L1 denials; SSH not executed');
} finally {
  terminalManager.executeCommand = originalExecute;
  delete process.env.LCM_SSH_APPROVAL_PUBLIC_KEY_FILE;
  delete process.env.LCM_SSH_APPROVAL_STATE_DIR;
  await fs.rm(dir,{recursive:true,force:true});
}
