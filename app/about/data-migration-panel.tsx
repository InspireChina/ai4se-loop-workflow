'use client';

import { AlertTriangle, CheckCircle2, DatabaseBackup, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import type { LegacyDatabaseMigrationReport } from '../../src/infrastructure/database';

function statusLabel(status: LegacyDatabaseMigrationReport['items'][number]['status']) {
  if (status === 'imported') return '已迁移';
  if (status === 'already-imported') return '已处理';
  if (status === 'failed') return '失败';
  return '已跳过';
}

export function DataMigrationPanel() {
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<LegacyDatabaseMigrationReport>();
  const [error, setError] = useState('');

  const migrate = async () => {
    setRunning(true);
    setError('');
    try {
      const response = await fetch('/api/data-migration', { method: 'POST' });
      const payload = await response.json() as LegacyDatabaseMigrationReport | { error?: string };
      if (!response.ok) {
        throw new Error('error' in payload ? payload.error || '数据迁移失败' : '数据迁移失败');
      }
      setReport(payload as LegacyDatabaseMigrationReport);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };

  return <div className="card migration-card">
    <div className="migration-head">
      <span className="executor-icon"><DatabaseBackup size={18}/></span>
      <div>
        <strong>历史数据迁移</strong>
        <p className="muted settings-description">扫描当前安装目录里的旧版项目数据库，将需求及其关联记录汇总到全局数据库。</p>
      </div>
      <button className="button" type="button" disabled={running} onClick={() => void migrate()}>
        {running ? <LoaderCircle className="spin" size={15}/> : <DatabaseBackup size={15}/>}
        {running ? '正在扫描迁移' : '扫描并迁移'}
      </button>
    </div>

    <p className="migration-note">迁移使用只读快照，不修改历史数据库；重复执行会自动跳过已迁移的数据。</p>
    {error && <div className="update-warning" role="alert"><AlertTriangle size={17}/><span>{error}</span></div>}
    {report && <div className="migration-result" aria-live="polite">
      <div className="migration-summary">
        <span><b>{report.discovered}</b> 个历史库</span>
        <span className="success"><b>{report.imported}</b> 个新迁移</span>
        <span><b>{report.alreadyImported}</b> 个已处理</span>
        <span><b>{report.skipped}</b> 个已跳过</span>
        <span className={report.failed ? 'error' : ''}><b>{report.failed}</b> 个失败</span>
      </div>
      {report.items.length === 0
        ? <p className="migration-empty"><CheckCircle2 size={16}/>没有发现旧版项目数据库。</p>
        : <details className="migration-details" open={report.imported > 0 || report.failed > 0}>
          <summary>查看扫描结果</summary>
          <div className="migration-items">
            {report.items.map((item) => <div className={`migration-item ${item.status}`} key={item.sourcePath}>
              <span className="badge">{statusLabel(item.status)}</span>
              <div><strong>{item.projectName || '未识别项目'}</strong><small>{item.workspaceRoot || item.sourcePath}</small><p>{item.message}</p></div>
            </div>)}
          </div>
        </details>}
    </div>}
  </div>;
}
