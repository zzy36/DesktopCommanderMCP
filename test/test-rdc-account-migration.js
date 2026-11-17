import {combineRdcHealth} from '../dist/remote-device/fleet/gateway-service.js';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createHash,generateKeyPairSync} from 'node:crypto';
import {RdcAccountMigration} from '../dist/remote-device/fleet/rdc-account-migration.js';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'rdc-rebind-'));
try{
 const key=generateKeyPairSync('rsa',{modulusLength:3072}).publicKey.export({type:'spki',format:'pem'});const helper='TEST_ONLY';
 const config=path.join(root,'package.json');await fs.writeFile(config,JSON.stringify({operation:'rdc-test-20261117',version:'0.3.0',targetEmailSha256:'a'.repeat(64),accountLabel:'new@example.test',operatorPublicKey:key,helper,cloudHelper:'CLOUD_TEST',cloudHelperSha256:createHash('sha256').update('CLOUD_TEST').digest('hex'),helperSha256:createHash('sha256').update(helper).digest('hex')}));
 const calls=[],controls=[];let accountMatches=false;
 const gateway={machineDeviceStatus:host=>{assert.equal(host,'YUAN');return {online:true}},dispatchDevice:async(host,tool,args)=>{calls.push({host,tool,args});return {content:[{type:'text',text:tool==='start_process'?JSON.stringify(args.command?.includes('cloud-health.mjs')?{hostname:host,cloudState:'online',cloudReason:'PROVIDER_STATUS_AND_HEARTBEAT'}:{hostname:host,stage:accountMatches?'PAIRED':'NOT_STARTED',savedAccountMatches:accountMatches}):'STUB'}]};}};
 const migration=new RdcAccountMigration(gateway,config,root,async(host,action)=>{controls.push({host,action});return {hostname:host,state:action==='start'?'Running':'Ready',processCount:0}});
 await migration.perform('YUAN','prepare');assert(calls.slice(0,4).every(c=>c.args.execution_context==='system'));assert(!JSON.stringify(calls).includes('refresh_token'));
 if(process.platform==='win32'){
  const runner=path.join(root,'run-agent.ps1'),script=path.join(root,'probe.ps1');
  await fs.writeFile(runner,`& '${process.execPath.replaceAll("'","''")}' 'ignored.js'`);
  let emitted;const probe=new RdcAccountMigration({...gateway,dispatchDevice:async(host,tool,args)=>{emitted=args.command;return {content:[{type:'text',text:JSON.stringify({hostname:host,stage:'NOT_STARTED'})}]}}},config,root,async()=>({state:'Ready'}));
  await probe.perform('YUAN','status');
  const prefix=emitted.slice(0,emitted.indexOf(';& ([string]$n[0])')).replace("(Join-Path $env:ProgramData 'NetworkFleet/run-agent.ps1')",`'${runner.replaceAll("'","''")}'`);
  const native=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',prefix+`; & ([string]$n[0]) -p 'JSON.stringify({ok:true})'`],{encoding:'utf8'});
  assert.equal(native.status,0,native.stderr);assert.equal(JSON.parse(native.stdout.trim()).ok,true);
 }
 await migration.perform('YUAN','begin');assert.equal(controls[0].action,'stop');assert(calls.filter(c=>c.tool==='start_process').every(c=>c.args.execution_context==='interactive'));
 await assert.rejects(migration.perform('YUAN','finish'),/not been verified/);assert(!controls.some(c=>c.action==='start'));
 const retryControls=[];let retrySafe=false;
 const failed=new RdcAccountMigration({...gateway,dispatchDevice:async(host,tool,args)=>({content:[{type:'text',text:JSON.stringify({hostname:host,stage:'FAILED',diagnostics:{preparationRetrySafe:retrySafe}})}]})},config,root,async(host,action)=>{retryControls.push(action);return {state:'Ready',processCount:0}});
 await assert.rejects(failed.perform('YUAN','begin'),/Previous RDC migration failed/);assert.equal(retryControls.length,0);
 retrySafe=true;assert.equal((await failed.perform('YUAN','begin')).stage,'STARTED');assert.deepEqual(retryControls,['stop']);
 accountMatches=true;const result=await migration.perform('YUAN','finish');assert.equal(result.stage,'CONNECTED');
 assert.equal((await migration.binding('YUAN')).accountMatches,true);
 const stored=await fs.readFile(path.join(root,'rdc-account-bindings.json'),'utf8');assert(!stored.includes('verificationCiphertext')&&!stored.includes('access_token'));
 assert.equal((await migration.perform('YUAN','health')).cloudState,'online');
 await migration.perform('YUAN','status');assert.equal((await migration.binding('YUAN')).accountStage,'CONNECTED');
 const runtimeHelper='RUNTIME_TEST',runtimeUserHelper='RUNTIME_USER_TEST';
 const runtimeConfig=JSON.parse(await fs.readFile(config,'utf8'));Object.assign(runtimeConfig,{runtimeVersion:'0.3.3',archiveSha256:'b'.repeat(64),runtimeHelper,runtimeHelperSha256:createHash('sha256').update(runtimeHelper).digest('hex'),runtimeUserHelper,runtimeUserHelperSha256:createHash('sha256').update(runtimeUserHelper).digest('hex')});await fs.writeFile(config,JSON.stringify(runtimeConfig));
 let compatible=false;const runtimeCalls=[];
 const runtime=new RdcAccountMigration({...gateway,dispatchDevice:async(host,tool,args)=>{runtimeCalls.push({tool,args});return {content:[{type:'text',text:JSON.stringify(args.command?.includes('check-user.mjs')?{hostname:host,accountMatches:true,deviceIdentityUnchanged:true,sessionCompatible:compatible}:{hostname:host,runtimeStage:'ACTIVATED'})}]};}},config,root,async()=>{throw Error('Must not stop RDC while staging')});
 await runtime.perform('YUAN','runtime-prepare');await runtime.perform('YUAN','runtime-stage');
 await assert.rejects(runtime.perform('YUAN','runtime-activate'),/preflight did not pass/);
 assert(!runtimeCalls.some(c=>c.args.command?.includes("-Action 'activate'")));
 compatible=true;assert.equal((await runtime.perform('YUAN','runtime-activate')).runtimeStage,'ACTIVATED');
 assert(runtimeCalls.filter(c=>c.args.command?.includes('check-user.mjs')).every(c=>c.args.execution_context==='interactive'));
 assert(runtimeCalls.filter(c=>c.args.command?.includes('Update-RDCRuntime.ps1')).every(c=>c.args.execution_context==='system'));
 console.log('PASS RDC migration: exact device, user context, verified-account gate, gateway sync, no credentials in gateway state');
}finally{await fs.rm(root,{recursive:true,force:true});}

assert.equal(combineRdcHealth({hostname:'YUAN',state:'Ready'},{cloudState:'online'}).cloudState,'offline');
assert.equal(combineRdcHealth({hostname:'YUAN',state:'Running'},{cloudState:'unknown'}).cloudState,'unknown');
assert.equal(combineRdcHealth({hostname:'YUAN',state:'Running'},{cloudState:'offline'}).cloudState,'offline');
