import {readFile,writeFile,rename} from 'node:fs/promises';
import {createHash,createPublicKey} from 'node:crypto';
import path from 'node:path';
import {FleetGateway} from './fleet-gateway.js';
import type {RdcAction,RdcStatus} from './admin-server.js';

type Action='prepare'|'begin'|'status'|'finish';
const actions=new Set(['prepare','begin','status','finish']);
const stages=new Set(['NOT_STARTED','AWAITING_BROWSER','SAVING','PAIRED','FAILED']);
export class RdcAccountMigration {
    private pending=new Map<string,{pid:number;content:any[]}>();
    private writing:Promise<unknown>=Promise.resolve();
    constructor(private gateway:FleetGateway,private packagePath:string,private stateDir:string,private control:(host:string,action:RdcAction)=>Promise<RdcStatus>){}
    private async config(){
        const d=JSON.parse(await readFile(this.packagePath,'utf8'));
        if(!/^[a-zA-Z0-9-]{8,80}$/.test(d.operation)||!/^[a-f0-9]{64}$/.test(d.targetEmailSha256)||d.version!=='0.3.0'||createHash('sha256').update(d.helper).digest('hex')!==d.helperSha256)throw new Error('RDC migration package invalid');
        const key=createPublicKey(d.operatorPublicKey);if(key.asymmetricKeyType!=='rsa'||(key.asymmetricKeyDetails?.modulusLength??0)<3072)throw new Error('Operator verification key invalid');
        return d;
    }
    async binding(hostname:string){
        try{return JSON.parse(await readFile(path.join(this.stateDir,'rdc-account-bindings.json'),'utf8')).devices?.[hostname]??{};}catch(e){if((e as any).code==='ENOENT')return {};throw e;}
    }
    private save(hostname:string,data:any){
        this.writing=this.writing.then(async()=>{
            const file=path.join(this.stateDir,'rdc-account-bindings.json');let d:any={schemaVersion:1,devices:{}};
            try{d=JSON.parse(await readFile(file,'utf8'));}catch(e){if((e as any).code!=='ENOENT')throw e;}
            d.devices[hostname]=data;const temp=file+'.stage';await writeFile(temp,JSON.stringify(d),{mode:0o600});await rename(temp,file);
        });return this.writing;
    }
    async perform(hostname:string,action:Action){
        if(!actions.has(action)||!/^[A-Z0-9-]+$/.test(hostname))throw new Error('Exact hostname and fixed RDC migration action required');
        if(!this.gateway.machineDeviceStatus(hostname).online)throw Object.assign(new Error('Exact LCM device offline'),{code:'TARGET_OFFLINE'});
        const cfg=await this.config();
        const root=`C:/ProgramData/LocalControlMCP-RDC/account-migration/${cfg.operation}`;
        const helper=root+'/rebind.mjs',config=root+'/config.json';
        const call=async(tool:string,args:Record<string,unknown>,context='interactive')=>{
            const r=await this.gateway.dispatchDevice(hostname,tool,{...args,execution_context:context},45000) as any;
            if(r?.isError)throw new Error(`RDC migration ${tool} failed in ${context} context`);return r;
        };
        const command=(mode:'begin'|'status')=>`$ErrorActionPreference='Stop'; $t=$null;$e=$null;$a=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $env:ProgramData 'NetworkFleet/run-agent.ps1'),[ref]$t,[ref]$e);$n=@($a.FindAll({param($x) $x -is [System.Management.Automation.Language.CommandAst] -and $x.GetCommandName() -match '(^|[\\/])node(\\.exe)?$'},$true)|ForEach-Object{$_.GetCommandName()}|Select-Object -Unique);if($e.Count -or $n.Count -ne 1){throw 'Registered Node executable is ambiguous'};& $n[0] '${helper}' '${mode}' '${config}'`;
        if(action==='prepare'){
            await call('create_directory',{path:root},'system');
            await call('write_file',{path:helper,mode:'rewrite',content:cfg.helper},'system');
            await call('write_file',{path:config,mode:'rewrite',content:JSON.stringify({hostname,operation:cfg.operation,version:cfg.version,targetEmailSha256:cfg.targetEmailSha256,operatorPublicKey:cfg.operatorPublicKey})},'system');
            return {hostname,stage:'PREPARED'};
        }
        const readStatus=async()=>{
            const pending=this.pending.get(hostname);
            const r=await call(pending?'read_process_output':'start_process',pending?{pid:pending.pid,timeout_ms:5000}:{command:command('status'),shell:'powershell.exe',timeout_ms:6000});
            const content=[...(pending?.content??[]),...(r.content??[])];
            const text=content.map((c:any)=>c.text??'').join('\n');
            for(const line of text.split(/\r?\n/).reverse()){
                try{const d=JSON.parse(line.trim());if(d.hostname===hostname && stages.has(d.stage)){this.pending.delete(hostname);return d;}}catch{}
            }
            const pid=pending?.pid??Number(text.match(/Process started with PID\s+(\d+)/)?.[1]);
            if(pid && !/Process completed|has finished execution/.test(text)){this.pending.set(hostname,{pid,content});return {hostname,stage:'STATUS_PENDING'};}
            throw new Error('RDC user-context status did not return the expected safe record');
        };
        const s=await readStatus();
        if(action==='begin'){
            if(s.stage==='STATUS_PENDING'||s.stage==='AWAITING_BROWSER'||s.savedAccountMatches)return s;
            if(s.stage==='FAILED')throw new Error('Previous RDC migration failed; inspect local state before restarting');
            const stopped=await this.control(hostname,'stop');
            if(stopped.state==='Running'||(stopped.processCount??0)>0)throw new Error('RDC has not stopped; read back before authorization');
            await call('start_process',{command:command('begin'),shell:'powershell.exe',timeout_ms:1000});
            return {hostname,stage:'STARTED'};
        }
        if(action==='finish'){
            if(!s.savedAccountMatches||s.stage!=='PAIRED')throw new Error('RDC credentials have not been verified for the requested account');
            const r=await this.control(hostname,'start');
            if(r.state!=='Running')throw new Error('RDC supervisor not running');
            await this.save(hostname,{operation:cfg.operation,accountLabel:cfg.accountLabel,accountMatches:true,accountStage:'CONNECTED',updatedAt:new Date().toISOString()});
            return {hostname,stage:'CONNECTED',accountMatches:true,supervisorRunning:true};
        }
        const previous=await this.binding(hostname);
        await this.save(hostname,{operation:cfg.operation,accountLabel:cfg.accountLabel,accountMatches:s.savedAccountMatches===true,accountStage:s.savedAccountMatches&&previous.operation===cfg.operation&&previous.accountStage==='CONNECTED'?'CONNECTED':s.stage,updatedAt:new Date().toISOString()});
        return s;
    }
}
