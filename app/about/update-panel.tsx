'use client';

import { CheckCircle2, Download, LoaderCircle, RefreshCw, RotateCcw, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';

type UpdateStatus = 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'downloaded' | 'error';

type UpdaterState = {
  supported: boolean;
  packaged: boolean;
  currentVersion: string;
  platform: string;
  arch: string;
  status: UpdateStatus;
  latestVersion?: string;
  releaseDate?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  error?: string;
};

type UpdaterBridge = {
  getState(): Promise<UpdaterState>;
  checkForUpdates(): Promise<UpdaterState>;
  downloadUpdate(): Promise<UpdaterState>;
  installUpdate(): Promise<boolean>;
  subscribe(listener: (state: UpdaterState) => void): () => void;
};

declare global {
  interface Window { loopworkUpdater?: UpdaterBridge }
}

const webState: UpdaterState = {
  supported: false,
  packaged: false,
  currentVersion: 'Web',
  platform: 'browser',
  arch: 'unknown',
  status: 'idle',
};

function systemLabel(platform: string, arch: string) {
  const system = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform;
  const cpu = arch === 'arm64' ? 'Apple Silicon / ARM64' : arch === 'x64' ? 'x64' : arch;
  return `${system} · ${cpu}`;
}

function bytes(value?: number) {
  if (!value) return '0 MB';
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function statusText(state: UpdaterState) {
  switch (state.status) {
    case 'checking': return '正在检查 GitHub Releases…';
    case 'available': return `发现新版本 ${state.latestVersion ?? ''}`;
    case 'up-to-date': return '当前已经是最新版本';
    case 'downloading': return `正在下载 ${state.latestVersion ?? '新版本'}…`;
    case 'downloaded': return `版本 ${state.latestVersion ?? ''} 已下载，重启后完成安装`;
    case 'error': return '更新失败';
    default: return '可以手动检查是否有新版本';
  }
}

export function UpdatePanel() {
  const [state, setState] = useState<UpdaterState>(webState);

  useEffect(() => {
    const updater = window.loopworkUpdater;
    if (!updater) return;
    void updater.getState().then(setState).catch((error) => setState((value) => ({ ...value, status: 'error', error: String(error) })));
    return updater.subscribe(setState);
  }, []);

  const updater = typeof window === 'undefined' ? undefined : window.loopworkUpdater;
  const checking = state.status === 'checking';
  const downloading = state.status === 'downloading';
  const progress = Math.round(state.percent ?? 0);

  return <div className="card update-card">
    <div className="update-head">
      <div><strong>软件更新</strong><p className="muted settings-description">当前版本 <b>v{state.currentVersion}</b> · {systemLabel(state.platform, state.arch)}</p></div>
      <span className={`badge ${state.status === 'up-to-date' || state.status === 'downloaded' ? 'green' : state.status === 'error' ? 'amber' : ''}`}>{statusText(state)}</span>
    </div>

    {downloading && <div className="update-progress" aria-label={`下载进度 ${progress}%`}>
      <div><span>下载进度</span><b>{progress}%</b></div>
      <progress max="100" value={progress}/>
      <small>{bytes(state.transferred)} / {bytes(state.total)}{state.bytesPerSecond ? ` · ${bytes(state.bytesPerSecond)}/s` : ''}</small>
    </div>}

    {state.status === 'error' && <div className="update-warning"><ShieldAlert size={17}/><span>{state.error || '无法完成更新，请稍后重试或从 Releases 手动下载安装包。'}</span></div>}
    {!state.supported && <div className="update-warning"><ShieldAlert size={17}/><span>{state.packaged ? '当前系统不支持应用内自动升级。' : '浏览器和开发模式不执行自动升级；请在安装后的桌面应用中使用。'}</span></div>}

    <div className="update-actions">
      {(state.status === 'idle' || state.status === 'up-to-date' || state.status === 'error') && <button className="button" type="button" disabled={!state.supported || checking} onClick={() => void updater?.checkForUpdates()}>{checking ? <LoaderCircle className="spin" size={15}/> : <RefreshCw size={15}/>}检查更新</button>}
      {state.status === 'checking' && <button className="button" type="button" disabled><LoaderCircle className="spin" size={15}/>正在检查</button>}
      {state.status === 'available' && <button className="button" type="button" onClick={() => void updater?.downloadUpdate()}><Download size={15}/>下载 v{state.latestVersion}</button>}
      {downloading && <button className="button" type="button" disabled><LoaderCircle className="spin" size={15}/>下载中</button>}
      {state.status === 'downloaded' && <button className="button success" type="button" onClick={() => void updater?.installUpdate()}><RotateCcw size={15}/>重启并安装</button>}
      {state.status === 'up-to-date' && <span className="update-ok"><CheckCircle2 size={16}/>无需更新</span>}
    </div>

    <small className="update-signing-note">自动升级会校验 Release 清单和文件哈希。当前公开构建尚未配置 Windows/macOS 代码签名，系统仍可能显示“未知发布者”或阻止静默安装。</small>
  </div>;
}
