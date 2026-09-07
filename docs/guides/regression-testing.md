# 组合回归测试指南

本文用于验证监控中间件、Site Agent 和可选 Alert Manager/Relay 的候选提交。目标是在不覆盖、不重启正式服务的前提下，证明同一个 Git 提交能够通过本地自动化测试和 Linux 隔离联调。

## 1. 测试层次

按以下顺序执行，任一步失败都应停止，不要继续发布：

1. 提交与工作树核验。
2. 语法检查和自动化测试。
3. Site Agent 上传协议联调。
4. Site Agent 真实 LibreNMS 只读采集联调。
5. Alert Manager/Relay 断网恢复端到端测试。
6. 临时资源清理与正式服务健康核验。

自动化测试通过不等于现场联调通过。特别是 Site Agent 和 Alert Relay 共用云端认证、存储及路由代码，修改共享代码后必须重新执行两类现场联调。

## 2. 前置条件

本地基础测试需要：

- Node.js 24；
- npm 或 pnpm；
- 与提交匹配的 `pnpm-lock.yaml`。

Ubuntu现场联调另外需要：

- Bash、curl、jq、ss；
- Alert端到端测试需要Docker；
- 正式监控中间件仅监听站点本机，例如 `127.0.0.1:4310`；
- 一个只读LibreNMS API Token，通过候选目录的临时 `.env` 提供；
- 测试端口未被占用。

不得把 `.env`、API Token、SNMP community、平台凭据或私钥加入Git、归档和工作日志。

## 3. 核验候选提交

在候选工作树中执行：

```bash
git status --short --branch
git log -1 --oneline --decorate
git diff-tree --check HEAD^ HEAD
git show --stat --summary HEAD
```

要求：

- 当前分支和预期一致；
- 工作树干净；
- `diff-tree --check`没有输出并返回0；
- 提交只包含本轮计划文件。

## 4. Windows基础回归

如果Node是便携版，只临时修改当前PowerShell会话的PATH：

```powershell
$nodeDir = '<NODE_DIRECTORY>'
$env:Path = "$nodeDir;$env:Path"
node --version
npm --version
npm run check
npm test
```

也可以使用已经安装的pnpm：

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

通过标准：语法检查退出码为0，所有测试通过且失败数为0。测试数量会随功能增加，不应只按固定数量判断。

## 5. 创建Linux候选包

仓库使用以下属性保证Shell脚本在Windows中仍以LF导出：

```gitattributes
*.sh text eol=lf
```

从明确的提交创建归档，不要直接打包含未提交修改的工作目录：

```powershell
$commit = git rev-parse HEAD
git archive --format=tar.gz --output=candidate.tar.gz $commit
Get-FileHash -Algorithm SHA256 candidate.tar.gz
```

传到测试机后重新计算SHA-256。两端必须一致：

```bash
sha256sum /tmp/candidate.tar.gz
```

首次验证或修改 `.gitattributes` 后，应检查Shell脚本格式：

```bash
file test-next/*.sh
```

输出不应包含 `with CRLF line terminators`。

## 6. 准备Ubuntu隔离目录

为每个提交使用一个新的、明确命名的 `/tmp` 目录，不覆盖旧现场：

```bash
candidate_dir=/tmp/site-agent-integration-<SHORT_COMMIT>
test ! -e "$candidate_dir"
install -d -m 700 "$candidate_dir"
tar -xzf /tmp/candidate.tar.gz -C "$candidate_dir"
install -m 600 /path/to/formal/runtime/.env "$candidate_dir/.env"
```

临时 `.env` 只用于读取站点现有只读配置。测试结束后立即删除：

```bash
rm -f -- "$candidate_dir/.env"
test ! -e "$candidate_dir/.env"
```

隔离源码可以保留用于复查，但不得残留凭据文件。

## 7. Site Agent协议联调

脚本启动一个临时云端进程，验证认证和多租户边界。示例使用24311，避免与正式4310冲突：

```bash
cd "$candidate_dir"
SITE_AGENT_PROJECT_DIR="$candidate_dir" \
SITE_AGENT_TEST_PORT=24311 \
pnpm test:site-agent-live
```

预期覆盖：

- 未认证上传返回401；
- 合法快照返回202；
- 重复批次幂等返回200；
- 合法租户能读取来源和快照；
- 伪造租户返回403；
- 跨租户资源表现为404；
- 乱序批次不能覆盖较新的快照；
- 敏感未知字段和非法JSON返回400；
- 超过2 MiB的请求返回413；
- 测试端口在结束后关闭；
- 正式4310仍为up。

## 8. Site Agent真实采集联调

该测试只读调用正式监控中间件，启动临时云端接收完整设备和端口快照：

```bash
cd "$candidate_dir"
SITE_AGENT_PROJECT_DIR="$candidate_dir" \
SITE_AGENT_LOCAL_URL=http://127.0.0.1:4310 \
SITE_AGENT_TEST_PORT=24311 \
SITE_AGENT_TEST_SEQUENCE=<MONOTONIC_INTEGER> \
pnpm test:site-agent-collector-live
```

通过标准：

- Agent上传设备数等于4310设备接口返回数量；
- Agent上传端口数等于4310端口接口的 `total`；
- 所有端口键唯一；
- 设备键、端口键和设备引用关系正确；
- 租户、站点和来源身份来自认证配置；
- 凭据不出现在结果、快照或日志中；
- 临时端口关闭，正式4310仍为up。

记录耗时和最大RSS，但开发环境的一次采样不能直接作为生产容量结论。

## 9. Alert Manager端到端联调

该脚本使用官方Alertmanager临时容器、临时Relay和临时云端：

```bash
cd "$candidate_dir"
pnpm test:alert-manager-live
```

默认隔离端口为24310、24312和29093。脚本覆盖：

- firing Webhook上传；
- 活动告警快照；
- 云端停止时文件队列保留；
- 云端恢复后的补传和确认删除；
- resolved Webhook上传；
- 临时进程、容器、Token文件和队列目录清理；
- 正式4310健康检查。

运行前先确认这些端口空闲，且不存在同名临时容器。测试失败时应先保留脚本输出的Relay、云端和Alertmanager诊断日志，再调查原因。

## 10. 最终环境核验

测试完成后至少检查：

```bash
ss -H -ltn '( sport = :24310 or sport = :24311 or sport = :24312 or sport = :29093 )'
docker ps -a --filter name=aiops-alertmanager-smoke
systemctl is-active aiops-chart-dashboard.service
systemctl show aiops-chart-dashboard.service -p NRestarts --value
curl -fsS http://127.0.0.1:4310/api/v1/monitoring/health
```

要求：临时端口无监听、临时容器无残留、正式服务为active/up，且 `NRestarts` 未因测试增加。

## 11. 失败处理规则

- 区分测试失败、环境缺失、端口冲突、换行错误和执行器/SSH封装错误。
- 不要在隔离目录临时修改后把结果宣称为“该提交通过”。应修改源工作树、提交、重新导出同一候选并复测。
- 不要为了测试关闭、覆盖或重启正式4310。
- 不要在未核对绝对路径时递归删除目录。
- 如测试创建了临时凭据副本，即使测试失败也必须删除该副本。
- 正式服务状态异常时立即停止后续测试，保存日志并按部署记录恢复。

## 12. 结果记录模板

每次候选至少记录：

```text
日期与时区：
分支：
完整提交ID：
候选包SHA-256：
Windows Node/npm/pnpm版本：
Ubuntu Node/pnpm版本：
语法检查：
自动化测试：通过数/失败数
Site Agent协议联调：
真实设备数/端口数：
真实采集耗时/最大RSS：
Alert Manager端到端：
Alertmanager/Relay资源快照：
临时端口与容器清理：
正式4310状态/NRestarts：
备份位置与SHA-256：
发现的问题及处理：
```

只有全部必需门禁通过、记录完整且恢复点可验证后，候选分支才适合推送或创建面向 `main` 的PR。
