# 可选 Alertmanager 与站点告警 Relay

此目录是增值部署参考，不是基础监控页面的必需组件。启用后，LibreNMS 使用原生 **Alertmanager Transport** 把告警送给官方 Alertmanager；Alertmanager 完成分组、去重、静默和抑制，再由 Relay 实时上传事件，并每 60 秒上传活动告警快照。

镜像固定为官方 `quay.io/prometheus/alertmanager:v0.33.1` 及已验证的多架构摘要 `sha256:9e0829…065d`。Relay 使用本仓库代码构建。管理端口仅映射到服务器回环地址，不直接暴露到局域网或公网。

示例按单节点站点部署，使用 `--cluster.listen-address=` 禁用 Gossip 集群等待。以后改为 Alertmanager 高可用集群时，应删除该参数并补充明确的集群 peer 配置。

## 1. 准备

确认 LibreNMS Compose 网络名称：

```bash
docker network ls
```

创建本机专用配置和两个凭据文件；不要把它们提交到 Git：

```bash
cd deploy/examples/alertmanager
umask 077
openssl rand -hex 32 > alertmanager-webhook.token
printf '%s' 'replace-with-cloud-issued-site-token' > site-agent-cloud.token
cp ../../../.env.alert-relay.example .env
```

编辑 `.env`，至少设置：

```dotenv
LIBRENMS_NETWORK_NAME=librenms_default
ALERT_CLOUD_URL=https://monitoring-cloud.example.com
ALERT_RELAY_TOKEN_FILE=./alertmanager-webhook.token
ALERT_CLOUD_TOKEN_FILE=./site-agent-cloud.token
```

先验证展开后的 Compose 配置。输出中只能看到凭据文件路径，不能出现凭据内容：

```bash
docker compose --profile alerts config
```

## 2. 启动与检查

```bash
docker compose --profile alerts up -d --build
docker compose --profile alerts ps
curl -fsS http://127.0.0.1:9093/-/ready
curl -fsS http://127.0.0.1:4312/health
```

在 LibreNMS 页面进入 `Alerts -> Alert Transports`，新增官方 **Alertmanager Transport**：

- URL：`http://alertmanager:9093`
- Options 建议添加 `source=librenms`、站点代号，以及 `dyn_device_id=device_id` 等实际可用动态标签。
- Username/Password 留空；访问边界由共享 Docker 网络控制。
- 用 LibreNMS 的 Transport 测试按钮验证，再让真实规则使用该 Transport。

## 3. 本地策略

静默由 Alertmanager 页面或 `amtool` 管理；抑制规则在 `alertmanager.yml`。修改后先验证并热重载：

```bash
docker compose --profile alerts exec alertmanager amtool check-config /etc/alertmanager/alertmanager.yml
docker compose --profile alerts kill -s HUP alertmanager
```

## 4. backup 与恢复

先停止写入再备份两个命名卷。以下命令在当前目录生成可带走的归档：

```bash
docker compose --profile alerts stop
docker run --rm -v aiops-alertmanager-data:/data:ro -v "$PWD":/backup alpine:3.22 tar -czf /backup/alertmanager-data.tar.gz -C /data .
docker run --rm -v aiops-alert-relay-data:/data:ro -v "$PWD":/backup alpine:3.22 tar -czf /backup/alert-relay-data.tar.gz -C /data .
sha256sum alertmanager-data.tar.gz alert-relay-data.tar.gz
docker compose --profile alerts start
```

将归档和 SHA-256 一起复制到虚拟机外保存。恢复前必须核对目标卷名和校验值。

## 5. rollback / 卸载

只停止可选组件且保留数据：

```bash
docker compose --profile alerts down
```

回滚代码时切换到已验证提交并重新构建；命名卷不会随 `down` 删除。只有在已经验证外部备份后，才可人工执行 `docker volume rm aiops-alertmanager-data aiops-alert-relay-data`。删除卷不可自动恢复。

如果不再使用告警链路，还需在 LibreNMS 中停用或删除对应 Alertmanager Transport，否则 LibreNMS 会继续尝试发送。
