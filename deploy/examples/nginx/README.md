# Nginx 可选参考

`aiops-lan.conf.example` 用于在同一台 Linux 主机上代理两个仅监听回环地址的服务：

- Nginx `18000` -> LibreNMS `127.0.0.1:8000`
- Nginx `14310` -> 统一监控页面 `127.0.0.1:4310`

示例安装方式（路径以 Debian/Ubuntu 为例）：

```bash
sudo cp aiops-lan.conf.example /etc/nginx/sites-available/aiops-lan.conf
sudo ln -s /etc/nginx/sites-available/aiops-lan.conf /etc/nginx/sites-enabled/aiops-lan.conf
sudo nginx -t
sudo systemctl reload nginx
```

注意事项：

- 这只是参考配置，不是项目启动的必要条件。
- 启用前检查端口是否占用，并按现场网络策略开放端口。
- 公网或不可信网络必须配置 TLS、认证和访问控制。
- 不要把具体公司的 IP、Windows `netsh portproxy` 或防火墙规则写入仓库。
