# LibreNMS 统一监控与 Site Agent

本项目提供一个可独立部署的 Node.js 监控中间件与可视化页面。它通过服务端调用 LibreNMS API，向浏览器提供统一监控接口；同时包含 Site Agent 的单次采集上传能力，为后续“站点主动连接云端”的架构打基础。

## 基础能力

- 在服务端保存并使用 LibreNMS API Token，Token 不下发到浏览器。
- 展示设备、告警、端口排行、端口详情和 RRD 时序图。
- 提供 `/api/v1/monitoring/*` 统一监控接口。
- 提供站点数据接收、鉴权、查询接口及本地端到端模拟工具。
- 提供 `site-agent:once`，从本地监控接口采集设备和端口快照并主动上传。
- 浏览器端不依赖 `crypto.randomUUID()`，可在普通 HTTP 的局域网访问场景中运行。

## 环境要求

- Node.js 20 或更高版本（推荐当前 LTS）
- pnpm 9 或更高版本
- 可访问的 LibreNMS 实例及只读 API Token

## 安装与启动

```bash
git clone <repository-url> site_agent
cd site_agent
pnpm install --frozen-lockfile
cp .env.monitoring.example .env
```

编辑 `.env`，至少填写：

```dotenv
HOST=127.0.0.1
PORT=4310
LIBRENMS_URL=http://127.0.0.1:8000
LIBRENMS_TOKEN=replace-with-a-read-only-token
```

启动服务：

```bash
pnpm start
```

浏览器默认访问 `http://127.0.0.1:4310/`。如果由 systemd、容器或进程管理器长期运行，也应使用同一个 `pnpm start` 入口。

## 测试

```bash
pnpm check
pnpm test
```

以下脚本需要已经运行的服务，属于可选的现场联调：

```bash
pnpm test:site-agent-live
pnpm test:site-agent-collector-live
```

## Site Agent 单次采集上传

复制示例配置并填写平台地址及分配给站点的凭据：

```bash
cp .env.site-agent.example .env.site-agent
set -a
. ./.env.site-agent
set +a
pnpm site-agent:once
```

`SITE_AGENT_LOCAL_URL` 指向本站点的监控中间件；`SITE_AGENT_CLOUD_URL` 指向云端接收接口。当前命令执行一次采集和上传，后续可以由 systemd timer、容器调度或平台心跳机制周期触发。

## 配置与安全

- `.env.example`：中间件及本地站点接收模拟的完整示例。
- `.env.monitoring.example`：只运行监控页面时的最小示例。
- `.env.site-agent.example`：Site Agent 单次上传示例。
- 不要提交真实 `.env`、LibreNMS Token、Site Agent Token、私钥或 SNMP 凭据。
- 生产环境应在反向代理层启用 TLS，并逐步将长期 Token 迁移到 mTLS 或短期凭据。

## 可选 Nginx 参考

`deploy/examples/nginx/` 提供通用反向代理示例。它不是基础功能的必需依赖，也不包含 Windows 防火墙、端口转发、现场 IP 或任何凭据。使用前请按部署环境调整监听端口、访问控制和 TLS。

## 目录说明

- `main.mjs`：HTTP 服务入口。
- `src/`：配置、LibreNMS 适配、业务服务和 Site Agent 实现。
- `public-next/`：前端页面与图表渲染器。
- `contracts/`：站点代理数据契约。
- `test-next/`：单元、回归和可选现场测试。
- `site-agent-once.mjs`：Site Agent 单次采集上传入口。
- `deploy/examples/`：非必需的部署参考。
