# AIOps Monitoring Visualization Module

该模块以 LibreNMS REST API 为首个数据 Provider，以 Chart.js 和 uPlot 为首个图表 Renderer。网页不会访问 LibreNMS 数据库，也不会获得 LibreNMS URL、Token 或原始响应。

## 数据链路

```text
LibreNMS REST API -> LibreNmsProvider -> MonitoringService
 -> /api/v1/monitoring/* -> VisualizationSpec -> RendererRegistry
 -> Chart.js / uPlot

站点 LibreNMS -> Site Agent 批量快照 -> /api/v1/site-agent/batches
 -> 租户隔离读模型 -> /api/v1/cloud/monitoring/*
```

- 替换 LibreNMS：实现与 `LibreNmsProvider` 相同的 Provider 方法，页面和 API 契约不变。
- 替换图表库：注册新的 Renderer，监控 API 和业务页面数据逻辑不变。
- LibreNMS 是权威存储；中间件只保留最多 `SERIES_MAX_POINTS` 个临时采样点，重启即清空。

## 安装和运行

```powershell
cd demo/chart-dashboard
pnpm install
$env:LIBRENMS_URL='http://127.0.0.1:8000'
$env:LIBRENMS_TOKEN='your-read-only-token'
pnpm start
```

浏览器打开 `http://127.0.0.1:4310`。

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 中间件监听地址 |
| `PORT` | `4310` | 中间件端口 |
| `LIBRENMS_URL` | `http://127.0.0.1:8000` | LibreNMS 根地址 |
| `LIBRENMS_TOKEN` | 空 | LibreNMS 只读 API Token |
| `LIBRENMS_TIMEOUT_MS` | `5000` | 上游请求超时 |
| `SERIES_MAX_POINTS` | `180` | 单端口内存采样上限 |
| `SITE_AGENT_CREDENTIALS_JSON` | 空 | 代理令牌到租户、站点、来源的服务端绑定；与查看凭据同时配置 |
| `PLATFORM_VIEWER_CREDENTIALS_JSON` | 空 | 平台查看令牌允许访问的租户列表；与代理凭据同时配置 |

站点代理接口当前属于协议验证版本：凭据从环境变量加载后会在内存中哈希，日志和响应不会输出令牌；生产部署必须使用 HTTPS，并在后续阶段迁移到 mTLS 或短期凭据。快照目前保存在进程内存中，服务重启后丢失。

## 页面与图表

- Chart.js：全设备端口总流量、利用率、错误数和丢弃数排行。
- uPlot：指定端口收发流量滚动时序图，每 10 秒请求一次标准化时序接口。
- LibreNMS Graph代理：指定设备资源和指定端口的历史图，支持自定义时间范围。
- 只读详情：资源当前传感器、可用率、ARP Table和Eventlog。
- 告警列表通过 DOM 文本节点渲染，不插入 LibreNMS 返回的 HTML。

## API 和验证

契约位于 `contracts/openapi.yaml`。

```powershell
pnpm test
pnpm run check
```

在 Linux/Ubuntu 上可运行不会修改正式4310服务的站点代理隔离测试：

```bash
pnpm run test:site-agent-live
```

该脚本默认使用 `127.0.0.1:4311`，临时生成测试令牌，覆盖认证、租户隔离、幂等、乱序、非法字段和请求大小限制，结束后自动关闭临时进程并删除临时数据。

测试使用注入的 Fake Provider，不访问真实 LibreNMS 或数据库。真实联调只需要配置只读 Token 后启动模块。

站点代理首批接口：

- `POST /api/v1/site-agent/batches`：代理上传设备和端口快照；
- `GET /api/v1/cloud/monitoring/sources`：列出当前平台身份可访问的数据源；
- `GET /api/v1/cloud/monitoring/sources/{sourceId}/snapshot`：读取指定来源的最新快照。

## 当前限制

LibreNMS 常见 Graph API 主要返回图片，并不提供适合 uPlot 的统一数组。历史Graph由中间件安全代理LibreNMS图片；uPlot仍通过中间件周期读取端口当前速率形成短期内存窗口。以后可在Provider内接入RRD导出服务、Prometheus或其他时序API，但必须继续返回同一个TimeSeriesFrame，不能让网页依赖下层格式。Notes明确不在本阶段范围内。
