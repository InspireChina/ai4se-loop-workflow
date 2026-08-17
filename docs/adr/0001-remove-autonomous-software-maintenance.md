# 移除自主软件维护

LoopWork 移除 Maintenance Runner、Maintenance Agent、修复队列、隔离 worktree patch、自动落地和自主维护页面，仅保留结构化运行事件与日志。升级 migration 直接删除自主软件维护的全部表和历史数据，不保留兼容读取。打包应用无法可靠修改并更新自身安装源码，而独立维护进程还会增加 Windows 更新时的进程残留与安装目录锁定风险；故障诊断和源码修复应由安装包之外的开发工作流完成。
