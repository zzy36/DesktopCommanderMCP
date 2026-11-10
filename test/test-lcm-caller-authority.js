import assert from 'node:assert/strict';
import {commandManager} from '../dist/command-manager.js';
import {configManager} from '../dist/config-manager.js';
import {startProcess} from '../dist/tools/improved-process-tools.js';
import {terminalManager} from '../dist/terminal-manager.js';
import {DesktopCommanderIntegration} from '../dist/remote-device/desktop-commander-integration.js';
import {ProjectResourceScope} from '../dist/remote-device/fleet/project-tool-contract.js';
import {DeviceExecutor} from '../dist/remote-device/fleet/device-executor.js';
import {createTestEnv} from './helpers/test-env.js';
const originalEnv=process.env.LCM_EXECUTOR_COMMAND_POLICY;
const originalConfig=configManager.getConfig, originalExecute=terminalManager.executeCommand;
const commands=['sudo apt-get update','reboot','shutdown -h now','halt','poweroff','init 6','netsh interface show interface','sc query','reg query HKLM','python -c print(init)'];
let launched=[];
try {
 configManager.getConfig=async()=>({blockedCommands:['sudo','reboot','shutdown','halt','poweroff','init','netsh','sc','reg'],defaultShell:'powershell.exe'});
 terminalManager.executeCommand=async(command)=>{launched.push(command);return {pid:12345,output:'STUB_ONLY',processState:{isWaitingForInput:false,isFinished:true},isBlocked:false};};
 process.env.LCM_EXECUTOR_COMMAND_POLICY='caller-authorized';
 for(const command of commands){const r=await startProcess({command,timeout_ms:1000});assert.notEqual(r.isError,true);}
 assert.deepEqual(launched,commands,'authorized commands reach the stub unchanged; none run');
 process.env.LCM_EXECUTOR_COMMAND_POLICY='legacy-blocklist';
 const denied=await startProcess({command:'sudo true',timeout_ms:1000,_meta:{commandPolicy:'caller-authorized'}});
 assert.equal(denied.isError,true);assert.equal(launched.length,commands.length,'tool args cannot select policy');
 const executor=new DeviceExecutor({callClientTool:async()=>{throw Error('should not execute')}},'YUAN',{command:process.execPath,args:['-e',`process.stdout.write(JSON.stringify({allow:false,reason:'explicit device policy'}))`]});
 await assert.rejects(executor.execute('start_process',{command:'sudo true'}),e=>e.code==='EXECUTION_POLICY_DENIED');
}finally{configManager.getConfig=originalConfig;terminalManager.executeCommand=originalExecute;if(originalEnv===undefined)delete process.env.LCM_EXECUTOR_COMMAND_POLICY;else process.env.LCM_EXECUTOR_COMMAND_POLICY=originalEnv;}
const fixture=createTestEnv();
try {
 for(const mode of ['caller-authorized','legacy-blocklist']) {
  const engine=new DesktopCommanderIntegration(mode==='caller-authorized'?{commandPolicy:mode}:{});
  const resolve=engine.resolveMcpConfig.bind(engine);
  engine.resolveMcpConfig=async()=>({...await resolve(),env:{...fixture.env,LCM_EXECUTOR_COMMAND_POLICY:'caller-authorized'}});
  try {
   await engine.initialize();
   const config=await engine.callClientTool('get_config',{});
   const parsed=JSON.parse(config.content[0].text.replace(/^Current configuration:\s*/,''));
   assert.equal(parsed.commandExecutionPolicy.mode,mode,'launcher selects policy, not inherited environment');
   const scoped=new ProjectResourceScope().transformDevice('get_config',config,'YUAN');
   assert.equal(JSON.parse(scoped.content[0].text).commandExecutionPolicy.mode,mode);
   const benign=await engine.callClientTool('start_process',{command:'node -e "console.log(123)"',timeout_ms:1000});assert.notEqual(benign.isError,true);
  }finally{await engine.shutdown();}
 }
}finally{fixture.cleanup();}
console.log('PASS LCM caller authority: administrative names forwarded to stub, no destructive commands executed; legacy config/explicit target denial retained; real stdio launch and config reporting verified');
