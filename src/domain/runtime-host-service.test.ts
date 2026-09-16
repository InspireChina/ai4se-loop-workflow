import assert from 'node:assert/strict';
import test from 'node:test';
import { renderRuntimeHostService, windowsHostArgument, type RuntimeHostServiceOptions } from './runtime-host-service';

function options(platform: RuntimeHostServiceOptions['platform'] = 'darwin'): RuntimeHostServiceOptions {
  const root = platform === 'win32' ? 'C:\\LoopWork & tools' : '/opt/LoopWork & tools';
  return { platform, executable: `${root}${platform === 'win32' ? '\\node.exe' : '/node'}`, appRoot: root,
    dataRoot: `${root}${platform === 'win32' ? '\\data' : '/data'}`, outputRoot: `${root}${platform === 'win32' ? '\\service' : '/service'}`,
    target: { kind: 'standalone', entry: `${root}${platform === 'win32' ? '\\host.cjs' : '/host.cjs'}` } };
}

test('launchd definition keeps the host alive with explicit roots and safe XML, never forcing business start', () => {
  const result = renderRuntimeHostService(options());
  const file = result.files[0]!;
  assert.equal(file.name, `${result.label}.plist`);
  assert.match(file.content, /<key>KeepAlive<\/key><true\/>/);
  assert.match(file.content, /ThrottleInterval<\/key><integer>10/);
  assert.match(file.content, /ExitTimeOut<\/key><integer>45/);
  assert.match(file.content, /LoopWork &amp; tools/);
  assert.deepEqual(result.args.slice(1), ['--app-root', '/opt/LoopWork & tools', '--data-root', '/opt/LoopWork & tools/data']);
  assert.doesNotMatch(file.content, /--start|task-start|task-transition/);
});

test('systemd definition disables restart exhaustion and quotes percent, quotes, backslashes and dollar paths without shell interpretation', () => {
  const source = options('linux'); source.appRoot = '/opt/LoopWork $HOME 50% "quoted" \\literal'; source.path = '/a/bin:/b 50%/bin';
  const file = renderRuntimeHostService(source).files[0]!.content;
  assert.match(file, /Restart=always/); assert.match(file, /StartLimitIntervalSec=0/);
  assert.match(file, /KillMode=control-group/); assert.match(file, /TimeoutStopSec=45/);
  assert.match(file, /ExecStart=:/); assert.match(file, /50%%/); assert.match(file, /\$HOME/);
  assert.match(file, /\\"quoted\\"/); assert.match(file, /\\\\literal/);
  assert.doesNotMatch(file, /\/bin\/sh|sudo|task-start/);
});

test('Windows registration uses current limited user, infinite periodic recovery, single instance and no battery cutoff', () => {
  const result = renderRuntimeHostService(options('win32'));
  assert.equal(result.files.length, 2);
  const registration = result.files.find(file => file.name.endsWith('.register.ps1'))!.content;
  assert.match(registration, /-MultipleInstances IgnoreNew/);
  assert.match(registration, /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.match(registration, /-RepetitionInterval \(New-TimeSpan -Minutes 1\)/);
  assert.doesNotMatch(registration, /RepetitionDuration|RestartCount|RunLevel Highest|password|\s-Force\b/i);
  assert.match(registration, /-LogonType Interactive -RunLevel Limited/);
  assert.match(registration, /DontStopIfGoingOnBatteries/);
  assert.match(registration, /Task already exists/);
});

test('standalone Electron receives run-as-node capability while desktop OS jobs execute the existing main process hidden', () => {
  for (const platform of ['darwin','linux','win32'] as const) {
    const source = options(platform);
    source.target = { ...source.target as { kind: 'standalone'; entry: string }, electronNode: true };
    const node = renderRuntimeHostService(source);
    assert.equal(node.environment.ELECTRON_RUN_AS_NODE, '1');
    assert.ok(node.args.includes('--electron-node'));
    const desktop = renderRuntimeHostService({ ...source, target: { kind: 'desktop' } });
    assert.deepEqual(desktop.args, ['--hidden']);
    assert.equal(desktop.environment.ELECTRON_RUN_AS_NODE, undefined);
    if (platform === 'win32') { assert.equal(desktop.files.length, 1); assert.doesNotMatch(desktop.files[0]!.content, /\.launch\.ps1/); }
  }
});

test('standalone service can execute an independent management image while diagnosing a separate business install',()=>{
  for(const platform of ['darwin','linux','win32'] as const){
    const source=options(platform);source.managementRoot=platform==='win32'?'C:\\LoopWork management':'/opt/LoopWork management';
    const rendered=renderRuntimeHostService(source);
    const index=rendered.args.indexOf('--management-root');assert.ok(index>0);assert.equal(rendered.args[index+1],source.managementRoot);
    assert.ok(rendered.args.includes('--app-root'));assert.notEqual(source.managementRoot,source.appRoot);
  }
});

test('Windows PowerShell wrapper treats apostrophes and interpolation-like paths as literal arguments', () => {
  const source = options('win32'); source.executable = "C:\\O'Brien\\$NODE`name.exe";
  const wrapper = renderRuntimeHostService(source).files.find(file => file.name.endsWith('.launch.ps1'))!.content;
  assert.match(wrapper, /O''Brien/); assert.match(wrapper, /\$NODE`name/);
  assert.match(wrapper, /exit \$LASTEXITCODE/);
  const registration = renderRuntimeHostService(source).files.find(file => file.name.endsWith('.register.ps1'))!.content;
  const encoded = registration.match(/"-EncodedCommand" "([A-Za-z0-9+/=]+)"/)![1]!;
  assert.equal(Buffer.from(encoded,'base64').toString('utf16le'),wrapper);
  assert.doesNotMatch(registration, /"-File"/);
  assert.equal(windowsHostArgument('C:\\with space\\'), '"C:\\with space\\\\"');
  assert.equal(windowsHostArgument('a"b'), '"a\\"b"');
});

test('service identity follows normalized data root, not candidate executable or source checkout', () => {
  const source = options(); const first = renderRuntimeHostService(source);
  const changed = renderRuntimeHostService({ ...source, executable: '/new/node', appRoot: '/new/source' });
  assert.equal(first.label, changed.label);
  const windows = options('win32');
  assert.equal(renderRuntimeHostService(windows).label, renderRuntimeHostService({ ...windows, dataRoot: windows.dataRoot.toLowerCase() }).label);
  assert.notEqual(first.label, renderRuntimeHostService({ ...source, dataRoot: '/other/data' }).label);
});

test('configuration rejects control characters, relative target paths, unsupported platform, unsafe labels and hot restart loops', () => {
  for (const change of [{ executable: 'relative' }, { dataRoot: '/data\nExecStart=/bad' }, { label: '../../other' },
    { restartSeconds: 0 }, { restartSeconds: 301 }, { platform: 'other' }]) {
    assert.throws(() => renderRuntimeHostService({ ...options(), ...change } as RuntimeHostServiceOptions));
  }
  assert.throws(() => renderRuntimeHostService({ ...options('win32'), outputRoot: '/tmp/host' }), /绝对路径/);
  assert.throws(() => renderRuntimeHostService({ ...options('win32'), target:{kind:'desktop'},path:'C:\\bin' }), /PATH/);
});
