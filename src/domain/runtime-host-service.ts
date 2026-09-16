import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';

export type RuntimeHostServiceOptions = {
  platform: 'darwin' | 'linux' | 'win32'; executable: string; appRoot: string; managementRoot?:string; dataRoot: string; outputRoot: string;
  target: { kind: 'standalone'; entry: string; electronNode?: boolean } | { kind: 'desktop' };
  path?: string; label?: string; restartSeconds?: number;
};
export type RuntimeHostServiceFile = { name: string; content: string };

const xml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
const ps = (value: string) => `'${value.replace(/'/g, "''")}'`;
const systemd = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
export const windowsHostArgument = (value: string) => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;

/** Render only; neither register a job nor overwrite an existing service.
 * OS restart is never permission to overwrite the durable business intent. */
export function renderRuntimeHostService(options: RuntimeHostServiceOptions) {
  if (!['darwin', 'linux', 'win32'].includes(options.platform)) throw new Error('不支持的宿主托管平台');
  const path = options.platform === 'win32' ? win32 : posix;
  const text = (value: string) => {
    if (!value || value.length > 32_000 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('宿主配置包含空值或控制字符');
    return value;
  };
  for (const value of [options.executable, options.appRoot, options.managementRoot, options.dataRoot, options.outputRoot,
    ...(options.target.kind === 'standalone' ? [options.target.entry] : [])]) {
    if(value===undefined)continue;
    if (!path.isAbsolute(text(value)) || options.platform === 'win32' && !/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)/.test(path.normalize(value))) {
      throw new Error('宿主配置路径必须是目标平台的绝对路径');
    }
  }
  if (options.path !== undefined) text(options.path);
  if (options.platform === 'win32' && options.target.kind === 'desktop' && options.path !== undefined) {
    throw new Error('Windows 桌面托管继承交互用户环境，不能声明未实际应用的 PATH 覆盖');
  }
  const identity = options.platform === 'win32' ? path.normalize(options.dataRoot).toLowerCase() : path.normalize(options.dataRoot);
  const label = options.label || `com.loopwork.host.${createHash('sha256').update(identity).digest('hex').slice(0, 20)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(label)) throw new Error('无效的宿主托管标识');
  const restart = options.restartSeconds ?? 10;
  if (!Number.isInteger(restart) || restart < 1 || restart > 300) throw new Error('宿主重启间隔必须是 1–300 秒');
  const args = options.target.kind === 'desktop' ? ['--hidden'] : [options.target.entry,
    '--app-root', options.appRoot, '--data-root', options.dataRoot,
    ...(options.managementRoot ? ['--management-root',options.managementRoot] : []),
    ...(options.target.electronNode ? ['--electron-node', options.executable] : [])];
  const environment: Record<string, string> = options.target.kind === 'standalone' ? {
    LOOP_APP_ROOT: options.appRoot, LOOP_DATA_ROOT: options.dataRoot,
    ...(options.target.electronNode ? { ELECTRON_RUN_AS_NODE: '1', LOOP_DESKTOP_NODE: options.executable } : {}),
  } : {};
  if (options.path !== undefined) environment.PATH = options.path;
  const stdout = path.join(options.dataRoot, 'host-service.stdout.log');
  const stderr = path.join(options.dataRoot, 'host-service.stderr.log');
  const files: RuntimeHostServiceFile[] = [];
  if (options.platform === 'darwin') {
    files.push({ name: `${label}.plist`, content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${[options.executable, ...args].map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(options.appRoot)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>${restart}</integer><key>ExitTimeOut</key><integer>45</integer>
<key>StandardOutPath</key><string>${xml(stdout)}</string><key>StandardErrorPath</key><string>${xml(stderr)}</string>
</dict></plist>
` });
  } else if (options.platform === 'linux') {
    files.push({ name: `${label}.service`, content: `[Unit]
Description=LoopWork independent supervision host
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${systemd(options.appRoot)}
ExecStart=:${[options.executable, ...args].map(systemd).join(' ')}
${Object.entries(environment).map(([key, value]) => `Environment=${systemd(`${key}=${value}`)}`).join('\n')}
Restart=always
RestartSec=${restart}
TimeoutStopSec=45
KillMode=control-group
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
` });
  } else {
    // A desktop task executes Electron directly; its main process owns native
    // startup and lifecycle. Standalone Electron/Node needs a small environment
    // wrapper because Task Scheduler has no per-action environment dictionary.
    const launcher = path.join(options.outputRoot, `${label}.launch.ps1`);
    const wrapper = `$ErrorActionPreference='Stop'
${Object.entries(environment).map(([key, value]) => `$env:${key} = ${ps(value)}`).join('\n')}
& ${ps(options.executable)} @(${args.map(ps).join(',')},'--watch-parent',[string]$PID)
exit $LASTEXITCODE
`;
    const encoded = Buffer.from(wrapper,'utf16le').toString('base64');
    if (options.target.kind === 'standalone' && encoded.length > 30_000) throw new Error('Windows 宿主启动参数超过命令行容量，不能生成不可启动的作业');
    const action = options.target.kind === 'desktop'
      ? `$action = New-ScheduledTaskAction -Execute ${ps(options.executable)} -Argument ${ps(args.map(windowsHostArgument).join(' '))} -WorkingDirectory ${ps(options.appRoot)}`
      : `$powershell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$action = New-ScheduledTaskAction -Execute $powershell -Argument ${ps(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded].map(windowsHostArgument).join(' '))} -WorkingDirectory ${ps(options.appRoot)}`;
    if (options.target.kind === 'standalone') files.push({ name: `${label}.launch.ps1`, content: wrapper });
    files.push({ name: `${label}.register.ps1`, content: `$ErrorActionPreference='Stop'
$name = ${ps(label)}
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { throw 'Task already exists; inspect and update it explicitly, do not overwrite it.' }
if (-not (Test-Path -LiteralPath ${ps(options.executable)} -PathType Leaf)) { throw 'Host executable missing' }
${options.target.kind === 'standalone' ? `if (-not (Test-Path -LiteralPath ${ps(options.target.entry)} -PathType Leaf)) { throw 'Host entry missing' }
if (-not (Test-Path -LiteralPath ${ps(launcher)} -PathType Leaf)) { throw 'Host launcher missing' }` : ''}
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
${action}
$login = New-ScheduledTaskTrigger -AtLogOn -User $user
$probe = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger @($login,$probe) -Settings $settings -Principal $principal | Out-Null
Start-ScheduledTask -TaskName $name
` });
  }
  return { label, files, executable: options.executable, args, environment };
}
