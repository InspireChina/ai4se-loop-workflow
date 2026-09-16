import { spawn } from 'node:child_process';
import {createHash} from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectProcessIdentity, processIdentityMatches, terminateProcessTree } from './process-tree';

type Platform = NodeJS.Platform;
type ContainedProcess = { allocationId: string; pid: number | null; marker?: string | null };

type JobReceipt = {
  schema: 'loop-windows-job/v1';
  allocationId: string;
  pid: number;
  jobName: string;
  assigned: boolean;
  activeProcesses?: number;
  error?: string;
};

const RECEIPT_SCHEMA = 'loop-windows-job/v1' as const;

function safeSegment(value: string) {
  const readable=value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0,80);
  return `${readable}-${createHash('sha256').update(value).digest('hex').slice(0,16)}`;
}

export function windowsJobPaths(dataRoot: string, allocationId: string) {
  const segment = safeSegment(allocationId);
  const directory = join(dataRoot, 'windows-job-containment');
  return {
    directory,
    ready: join(directory, `${segment}.ready.json`),
    outcome: join(directory, `${segment}.outcome.json`),
    jobName: `Local\\LoopWork-${segment}`,
  };
}

export function withWindowsJobAdmission(
  env: NodeJS.ProcessEnv,
  dataRoot: string,
  allocationId: string,
  platform: Platform = process.platform,
) {
  if (platform !== 'win32') return env;
  const paths = windowsJobPaths(dataRoot, allocationId);
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  return {
    ...env,
    LOOP_WINDOWS_JOB_ALLOCATION: allocationId,
    LOOP_WINDOWS_JOB_READY: paths.ready,
  };
}

function ps(value: string) { return `'${value.replaceAll("'", "''")}'`; }

/** The target entrypoint waits on the ready receipt before it can create a
 * descendant. The guardian therefore assigns the still-quiescent root to a
 * kill-on-close Job Object without relying on taskkill's tree snapshot. */
export function windowsJobGuardianScript(input: { dataRoot: string; allocationId: string; pid: number }) {
  const paths = windowsJobPaths(input.dataRoot, input.allocationId);
  return String.raw`
$ErrorActionPreference = 'Stop'
$allocation = ${ps(input.allocationId)}
$targetPid = ${input.pid}
$jobName = ${ps(paths.jobName)}
$readyPath = ${ps(paths.ready)}
$outcomePath = ${ps(paths.outcome)}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LoopWorkJob {
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public UInt64 ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] public struct BASIC_LIMIT { public Int64 PerProcessUserTimeLimit, PerJobUserTimeLimit; public UInt32 LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public UInt32 ActiveProcessLimit; public UIntPtr Affinity; public UInt32 PriorityClass, SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] public struct EXTENDED_LIMIT { public BASIC_LIMIT BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] public struct BASIC_ACCOUNTING { public Int64 TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public UInt32 TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, IntPtr returnedLength);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(UInt32 access, bool inherit, UInt32 pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateJobObject(IntPtr job, UInt32 exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern UInt32 WaitForSingleObject(IntPtr handle, UInt32 milliseconds);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
function Write-Receipt([string]$path, [object]$value) {
  $temp = "$path.$PID.tmp"
  $value | ConvertTo-Json -Compress | Set-Content -LiteralPath $temp -Encoding UTF8
  Move-Item -LiteralPath $temp -Destination $path -Force
}
$job = [LoopWorkJob]::CreateJobObject([IntPtr]::Zero, $jobName)
if ($job -eq [IntPtr]::Zero) { throw "CreateJobObject failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
$process = [IntPtr]::Zero
try {
  $limit = New-Object LoopWorkJob+EXTENDED_LIMIT
  $limit.BasicLimitInformation.LimitFlags = 0x00002000 # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  $size = [Runtime.InteropServices.Marshal]::SizeOf($limit)
  $memory = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
  try {
    [Runtime.InteropServices.Marshal]::StructureToPtr($limit, $memory, $false)
    if (-not [LoopWorkJob]::SetInformationJobObject($job, 9, $memory, $size)) { throw "SetInformationJobObject failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($memory) }
  $process = [LoopWorkJob]::OpenProcess(0x001F0FFF, $false, $targetPid)
  if ($process -eq [IntPtr]::Zero) { throw "OpenProcess failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  if (-not [LoopWorkJob]::AssignProcessToJobObject($job, $process)) { throw "AssignProcessToJobObject failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  Write-Receipt $readyPath @{ schema='${RECEIPT_SCHEMA}'; allocationId=$allocation; pid=$targetPid; jobName=$jobName; assigned=$true }
  [void][LoopWorkJob]::WaitForSingleObject($process, 0xffffffff)
  [void][LoopWorkJob]::TerminateJobObject($job, 1)
  $accounting = New-Object LoopWorkJob+BASIC_ACCOUNTING
  $accountingSize = [Runtime.InteropServices.Marshal]::SizeOf($accounting)
  $accountingMemory = [Runtime.InteropServices.Marshal]::AllocHGlobal($accountingSize)
  try {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
      if (-not [LoopWorkJob]::QueryInformationJobObject($job, 1, $accountingMemory, $accountingSize, [IntPtr]::Zero)) { throw "QueryInformationJobObject failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
      $accounting = [Runtime.InteropServices.Marshal]::PtrToStructure($accountingMemory, [type][LoopWorkJob+BASIC_ACCOUNTING])
      if ($accounting.ActiveProcesses -eq 0) { break }
      Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)
    Write-Receipt $outcomePath @{ schema='${RECEIPT_SCHEMA}'; allocationId=$allocation; pid=$targetPid; jobName=$jobName; assigned=$true; activeProcesses=[int]$accounting.ActiveProcesses }
  } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($accountingMemory) }
} catch {
  Write-Receipt $outcomePath @{ schema='${RECEIPT_SCHEMA}'; allocationId=$allocation; pid=$targetPid; jobName=$jobName; assigned=$false; activeProcesses=-1; error=$_.Exception.Message }
  throw
} finally {
  if ($process -ne [IntPtr]::Zero) { [void][LoopWorkJob]::CloseHandle($process) }
  [void][LoopWorkJob]::CloseHandle($job)
}
`;
}

function readReceipt(path: string): JobReceipt | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/,'')) as JobReceipt;
    return value.schema === RECEIPT_SCHEMA ? value : null;
  } catch { return null; }
}

async function waitForReceipt(path: string, accept: (receipt: JobReceipt) => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  do {
    const receipt = readReceipt(path);
    if (receipt && accept(receipt)) return receipt;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return null;
}

export async function attachWindowsJobContainment(input: {
  dataRoot: string; allocationId: string; pid: number; platform?: Platform; timeoutMs?: number;
}) {
  if ((input.platform ?? process.platform) !== 'win32') return true;
  const paths = windowsJobPaths(input.dataRoot, input.allocationId);
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  const script = windowsJobGuardianScript(input);
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const guardian = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    detached: true, windowsHide: true, stdio: 'ignore',
  });
  const failed=new Promise<null>(resolve=>guardian.once('error',()=>resolve(null)));
  guardian.unref();
  const receipt = await Promise.race([waitForReceipt(paths.ready, value => value.allocationId === input.allocationId
    && value.pid === input.pid && value.assigned, input.timeoutMs ?? 10_000),failed]);
  return Boolean(receipt);
}

export async function waitForWindowsJobAdmission(
  env: NodeJS.ProcessEnv = process.env,
  pid = process.pid,
  timeoutMs = 15_000,
) {
  const allocationId = env.LOOP_WINDOWS_JOB_ALLOCATION;
  const ready = env.LOOP_WINDOWS_JOB_READY;
  if(!allocationId && !ready)return;
  if(!allocationId || !ready)throw new Error('Windows Job admission environment is incomplete');
  const receipt = await waitForReceipt(ready, value => value.allocationId === allocationId && value.pid === pid && value.assigned, timeoutMs);
  if(!receipt)throw new Error(`Windows Job admission timed out: ${allocationId}`);
}

export async function confirmWindowsJobContainmentExit(input: {
  dataRoot: string; process: ContainedProcess; platform?: Platform; timeoutMs?: number;
}) {
  if ((input.platform ?? process.platform) !== 'win32') return false;
  const record = input.process;
  if (!record.pid) return false;
  const paths = windowsJobPaths(input.dataRoot, record.allocationId);
  const proven = () => {
    const receipt = readReceipt(paths.outcome);
    return Boolean(receipt?.assigned && receipt.allocationId === record.allocationId && receipt.pid === record.pid && receipt.activeProcesses === 0);
  };
  if (proven()) return true;
  let mayTerminate=true;
  if (record.marker) {
    const identity = await inspectProcessIdentity(record.pid);
    if (identity && !processIdentityMatches(identity, record.marker)) mayTerminate=false;
  }
  if(mayTerminate)await terminateProcessTree(record.pid, Math.min(5_000, input.timeoutMs ?? 15_000), record.marker ?? undefined);
  const receipt = await waitForReceipt(paths.outcome, value => value.assigned && value.allocationId === record.allocationId
    && value.pid === record.pid && value.activeProcesses === 0, input.timeoutMs ?? 15_000);
  return Boolean(receipt);
}

export async function isProcessInWindowsJob(input:{dataRoot:string;allocationId:string;pid:number;platform?:Platform;timeoutMs?:number}) {
  if((input.platform??process.platform)!=='win32')return false;
  const paths=windowsJobPaths(input.dataRoot,input.allocationId);
  const script=String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LoopWorkJobMembership {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr OpenJobObject(UInt32 access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(UInt32 access, bool inherit, UInt32 pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
$job=[LoopWorkJobMembership]::OpenJobObject(0x0004,$false,${ps(paths.jobName)})
$target=[LoopWorkJobMembership]::OpenProcess(0x1000,$false,${input.pid})
try { $inside=$false; if($job -eq [IntPtr]::Zero -or $target -eq [IntPtr]::Zero -or -not [LoopWorkJobMembership]::IsProcessInJob($target,$job,[ref]$inside)){ exit 2 }; if($inside){'true'}else{'false'} }
finally { if($target -ne [IntPtr]::Zero){[void][LoopWorkJobMembership]::CloseHandle($target)}; if($job -ne [IntPtr]::Zero){[void][LoopWorkJobMembership]::CloseHandle($job)} }
`;
  const encoded=Buffer.from(script,'utf16le').toString('base64');
  return new Promise<boolean>(resolve=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{windowsHide:true,stdio:['ignore','pipe','ignore']});
    let output='';let settled=false;let timer:NodeJS.Timeout|undefined;
    const finish=(value:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};
    child.stdout?.on('data',bytes=>{output=(output+bytes.toString()).slice(-64);});
    child.once('error',()=>finish(false));child.once('close',code=>finish(code===0&&output.trim()==='true'));
    timer=setTimeout(()=>{child.kill('SIGKILL');finish(false);},input.timeoutMs??5000);timer.unref();
  });
}
