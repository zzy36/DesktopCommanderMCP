import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {commandPolicyMaintenance} from '../dist/remote-device/fleet/command-policy-maintenance.js';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'lcm-policy-package-'));
try {
 const release='a'.repeat(40), installer='TEST_ONLY_NEVER_EXECUTED';const file=path.join(root,'package.json');
 await fs.writeFile(file,JSON.stringify({release,policy:'caller-authorized',installer,installerSha256:createHash('sha256').update(installer).digest('hex'),files:[]}));
 const calls=[];const gateway={machineDeviceStatus:hostname=>{assert.equal(hostname,'YUAN');return {online:true}},dispatchDevice:async(host,tool,args)=>{calls.push({host,tool,args});return {content:[{type:'text',text:'STUB_ONLY'}]}}};
 const update=commandPolicyMaintenance(gateway,file,release);
 const r=await update('YUAN');assert.equal(r.status,'scheduled');assert.equal(calls.length,4);
 assert(calls.every(c=>c.host==='YUAN'&&c.args.execution_context==='system'));
 assert.deepEqual(calls.map(c=>c.tool),['create_directory','write_file','write_file','start_process']);
 assert.match(calls[3].args.command,/Register-ScheduledTask/);assert(!calls[3].args.command.includes('reboot'));
 calls.length=0;assert.equal((await update('YUAN','prepare')).status,'prepared');assert.equal(calls.length,3);
 calls.length=0;await update('YUAN','status');assert.deepEqual(calls.map(c=>c.tool),['read_file','start_process','start_process']);
 calls.length=0;await assert.rejects(commandPolicyMaintenance(gateway,file,'b'.repeat(40))('YUAN'),/mismatch/);assert.equal(calls.length,0);
 await update('YUAN','prepare');calls.length=0;
 gateway.dispatchDevice=async(host,tool,args)=>{calls.push({host,tool,args});return {content:[{type:'text',text:tool==='start_process'?'Process started with PID 77\\nProcess is running':tool==='read_process_output'?'Process completed with exit code 0':'STUB_ONLY'}]};};
 await update('YUAN','status');await update('YUAN','status');
 assert.equal(calls.filter(c=>c.tool==='start_process').length,2,'pending diagnostics must not be launched twice');
 assert.equal(calls.filter(c=>c.tool==='read_process_output').length,2,'pending owned process output is read instead');
 gateway.dispatchDevice=async()=>({isError:true});await assert.rejects(update('YUAN'),e=>e.code==='MAINTENANCE_REJECTED');
 console.log('PASS pinned product maintenance: release mismatch rejected, exact target preserved, task scheduling stubbed, no remote commands executed');
}finally{await fs.rm(root,{recursive:true,force:true})}
