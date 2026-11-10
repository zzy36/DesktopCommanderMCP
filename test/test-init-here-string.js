import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {commandManager} from '../dist/command-manager.js';
import {configManager} from '../dist/config-manager.js';
// Synthetic, sanitized reproducer. Never executed; no target host or paths.
const repro = "$code = @'\n# don't interpret Python as shell\ninit = 1\nprint(init)\n'@\n$code | python -";
if (process.platform === 'win32') {
 const parsed = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',
  '$text=[Console]::In.ReadToEnd(); $tokens=$null; $errors=$null; $ast=[System.Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors); if($errors.Count){exit 1}; $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.CommandAst]},$true) | ForEach-Object { $_.GetCommandName() }'], {input:repro,encoding:'utf8'});
 assert.equal(parsed.status,0,parsed.stderr);
 assert.match(parsed.stdout,/python/);
 assert.doesNotMatch(parsed.stdout,/init/,'PowerShell AST must treat init as literal data');
}
const original = configManager.getConfig;
configManager.getConfig = async () => ({defaultShell:'pwsh',blockedCommands:['init','reboot','shutdown','sudo','rm','mkfs']});
try {
 assert.ok(commandManager.extractCommands(repro).includes('init'), 'legacy generic scanner reproduces false positive');
 assert.equal(await commandManager.validateCommand(repro),true);
 assert.equal(await commandManager.validateCommand(repro,'bash'),false,'PowerShell literal handling is shell-specific');
 for (const dangerous of ['init 0','reboot','shutdown -h now','/usr/bin/sudo true','echo $(init 0)','echo `reboot`','(shutdown -h now)','echo ok\ninit 0',repro+'\ninit 0',repro+'; reboot', "$x=@'\ndata\n'@; shutdown -h now", 'echo "$(mkfs /dev/example)"']) {
  assert.equal(await commandManager.validateCommand(dangerous),false, dangerous);
 }
 assert.equal(await commandManager.validateCommand(repro.replaceAll('\n','\r\n')),true);
 console.log('PASS: synthetic init false positive, shell boundary, CRLF, 12 dangerous-command denials; no commands executed');
} finally {configManager.getConfig=original;}
