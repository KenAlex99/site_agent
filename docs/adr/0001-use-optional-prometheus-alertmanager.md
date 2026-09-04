# ADR-0001: 使用可选的官方 Prometheus Alertmanager

## Status

Accepted

## Context

每个代理站点可能运行 LibreNMS、Prometheus 或其他监控系统。统一平台需要及时接收 firing、resolved 和 suppressed 告警，同时在公网中断或进程重启后恢复发送。基础设备与端口监控不能强制承担告警组件的资源成本。

自行实现分组、去重、路由、静默和抑制风险高；LibreNMS 已提供官方 Alertmanager Transport，Alertmanager 也提供 API v2 和通用 Webhook。

非功能目标：

- Alertmanager 和 Relay 均为可选安装；未启用时不启动进程或占用端口。
- Relay 对已经返回成功的 Webhook 实现进程重启不丢失。
- 站点只主动连接云端，Alertmanager API 不暴露公网。
- 实时事件通过 Webhook 上传；每60秒发送活跃告警快照校准。
- 平台依据认证绑定 tenant/site/source，拒绝客户端身份伪造。
- 默认队列上限为10,000项或256 MiB，并暴露深度、字节数和最旧事件年龄。

## Decision

在可选的 `alerts` 部署组合中运行未修改的官方 Prometheus Alertmanager，以及本项目提供的 Node.js `alert-relay`：

1. LibreNMS 使用原生 Alertmanager Transport 把告警发送到本地 Alertmanager。
2. 其他监控系统优先使用原生 Alertmanager/API v2 集成，只有不兼容时才增加适配器。
3. Alertmanager 使用 Webhook 把分组后的 firing/resolved 通知发送给 Relay。
4. Relay 验证本地 Bearer Token、限制请求大小、过滤标签和注释，然后先写原子文件队列再返回202。
5. 单上传Worker按序向云端 `alert-events` 接口发送；2xx后删除，临时故障退避重试，永久无效数据移入死信目录。
6. Relay每60秒读取 `/api/v2/alerts`，生成完整活跃告警快照并通过 `alert-snapshots` 接口上传。
7. 云端使用Site Agent身份认证生成全局告警键，不信任载荷中的租户或站点字段。
8. 第一阶段静默/抑制在站点Alertmanager管理；后续控制面完成后再由云端安全下发。

第一阶段采用原子文件队列。达到以下任一条件时评估SQLite：持续5事件/秒、峰值50事件/秒、队列经常超过10,000项或256 MiB、恢复扫描超过30秒、入队p95超过50毫秒、需要多个Worker或复杂查询。云端持续超过100事件/秒、50至100站点或千万级历史时评估PostgreSQL加消息队列。

## Consequences

### Positive

- 复用成熟的分组、去重、静默、抑制和路由能力。
- 告警功能可以独立启停，基础部署保持轻量。
- Webhook低延迟与快照最终一致性兼得。
- 文件队列无需新增数据库或原生Node依赖，便于检查、备份和恢复。

### Negative

- 启用告警时增加两个容器及配置、数据卷和升级工作。
- LibreNMS必须配置Alertmanager Transport。
- 原子文件队列不适合高并发、多Worker和大规模查询。
- 第一阶段站点静默规则不能从云端统一编辑。

### Neutral

- Alertmanager源码不复制到本仓库；部署时固定并审查官方镜像版本。
- 平台仍需长期持久化告警历史，本ADR只决定站点侧第一阶段。

## Alternatives Considered

**在Node.js中重写完整Alert Manager**

- 拒绝：重复实现成熟逻辑，告警风暴、恢复通知和静默语义风险较高。

**复制并修改Alertmanager源码**

- 拒绝：形成长期维护分叉，安全升级和上游合并成本高。

**只轮询LibreNMS API并直接上传云端**

- 保留为兼容/校准手段，不作为LibreNMS实时主路径；它延迟更高且绕过原生Transport。

**只使用Webhook，不发送快照**

- 拒绝：无法可靠修复断网、重启或通知丢失后的平台状态。

## References

- https://prometheus.io/docs/alerting/latest/alertmanager/
- https://prometheus.io/docs/alerting/latest/alerts_api/
- https://prometheus.io/docs/alerting/latest/configuration/
- https://docs.librenms.org/Alerting/Transports/Alertmanager/

