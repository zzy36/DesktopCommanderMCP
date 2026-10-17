import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import { ProjectResourceScope, scopeProjectToolArgs, validateProjectToolPaths } from '../dist/remote-device/fleet/project-tool-contract.js';
const scope=new ProjectResourceScope();const result=text=>({content:[{type:'text',text}]});
scope.record('start_process','project.a',result('Process started with PID 12'));
scope.record('start_process','project.b',result('Process started with PID 312'));
const listed=scope.transform('list_sessions','project.a',{},result('PID: 312, Blocked: false, Runtime: 1s\nPID: 12, Blocked: false, Runtime: 2s'),'YUAN');
assert(!JSON.stringify(listed).includes('312'));assert(JSON.stringify(listed).includes('PID: 12'));
scope.record('start_search','project.a',result('search session: search_1'));
scope.record('start_search','project.b',result('search session: search_10'));
const searches=scope.transform('list_searches','project.a',{},result('Active Searches (2):\n\nSession: search_10\n  Pattern: "sensitive"\n\nSession: search_1\n  Pattern: "allowed"'),'YUAN');
assert(!JSON.stringify(searches).includes('sensitive'));assert(JSON.stringify(searches).includes('allowed'));
const deviceConfig=JSON.parse(scope.transformDevice('get_config',result(JSON.stringify({version:'0.2.52',currentClient:{name:'desktop-commander-client',version:'1.0.0'},defaultShell:'pwsh.exe',fileReadLineLimit:1000,fileWriteLineLimit:50,telemetryEnabled:false,blockedCommands:['mkfs'],systemInfo:{platform:'win32',platformName:'Windows',isWindows:true,isLinux:false,isMacOS:false}})),'YUANS').content[0].text);
assert.equal(deviceConfig.product,'Local Control MCP');assert.equal(deviceConfig.scope_kind,'device');assert.equal(deviceConfig.device_name,'YUANS');assert.equal(deviceConfig.defaultShell,'pwsh.exe');assert(!('currentClient' in deviceConfig));assert(!('version' in deviceConfig));
const temp=await mkdtemp(path.join(os.tmpdir(),'lcm-path-'));
try{
 const root=path.join(temp,'project');const outside=path.join(temp,'outside');await mkdir(root);await mkdir(outside);
 await symlink(outside,path.join(root,'escape'),process.platform==='win32'?'junction':'dir');
 const auth={projectId:'project.a',deviceName:'YUAN',physicalRoot:root,partitionId:'network'};
 for(const name of ['read_file','write_file','list_directory']){const args=scopeProjectToolArgs(name,{path:'escape/private.txt'},auth);await assert.rejects(validateProjectToolPaths(name,args,auth),/resolves outside/);}
 await validateProjectToolPaths('write_file',scopeProjectToolArgs('write_file',{path:'new/inside.txt'},auth),auth);
 console.log('EXACT_RESOURCE_FILTER_AND_REALPATH_CONFINEMENT_PASS');
}finally{await rm(temp,{recursive:true,force:true})}
