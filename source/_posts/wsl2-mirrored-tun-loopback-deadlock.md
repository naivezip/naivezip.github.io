---
title: WSL2 与代理 TUN 模式死锁排查
date: 2026-10-15 21:30:00
categories: 
  - 网络
tags: 
  - WSL2
  - TUN
  - Mihomo
---

在 Windows 11 下使用 WSL2 配合代理软件（Mihomo / Clash）的 TUN 模式时，启动 WSL2 经常会导致网络直接瘫痪，节点测速全部超时，日志疯狂报错：

```json
{"type":"warning","payload":"[TCP] dial DIRECT ... error: reject loopback connection to: ..."}
```

----

## 问题原因

出现 `reject loopback connection` 是因为代理内核检测到了回环。

查一下物理网卡的接口配置：

```powershell
Get-NetIPInterface -AddressFamily IPv4 | Where-Object { $_.ConnectionState -eq 'Connected' }
```

会发现物理网卡（以太网 / WLAN）的 `Forwarding` 变成了 `Enabled`。

这是 Windows 的 HNS（Host Network Service）在启动虚拟网络时修改的。当物理网卡开启了转发后：

1. 代理软件在直连（DIRECT）或者连接节点服务器时，会将 Socket 绑定到物理网卡 IP 发送数据包。
2. Windows 协议栈因为物理网卡开启了 `Forwarding`，把这个发出的包误判成了需要转发的数据包。
3. TUN 模式下系统的路由表被接管（`0.0.0.0/1`），系统把这个包又重新路由回灌到了 TUN 虚拟网卡中。
4. 代理内核检测到数据包回环，触发熔断，直接拒绝连接，导致全局断网。

----

## 昨天的误区

昨天排查出是物理网卡 `Forwarding` 的问题后，我写了一个脚本加计划任务（`wsl-mirrornetwork-patch`），想在 WSL 启动时通过 hook 调用计划任务去强制把物理网卡的 `Forwarding` 改成 `Disabled`。

今天重新理了一下发现根本没必要这么折腾，昨天写的脚本完全用不上。

这个死锁本质上是镜像网络（`networkingMode=mirrored`）引入的。镜像网络并不是必需的，直接用回默认的 `nat` 模式，把配置配好就完全不会有这个问题。

----

## 解决办法

### 1. 切回 NAT 模式并清理残留状态

修改 `%USERPROFILE%\.wslconfig`，改回默认的 NAT 模式：

```ini
[wsl2]
autoProxy=false
```

之前 HNS 可能会把转发状态写进持久库（`PersistentStore`），需要彻底关闭物理网卡的转发：

```powershell
# 管理员权限运行
Set-NetIPInterface -InterfaceAlias "以太网" -AddressFamily IPv4 -Forwarding Disabled -PolicyStore ActiveStore
Set-NetIPInterface -InterfaceAlias "以太网" -AddressFamily IPv4 -Forwarding Disabled -PolicyStore PersistentStore
```

### 2. NAT 模式下的代理配置

代理软件中开启 **允许局域网连接（Allow LAN）**。

在 WSL2 的 `~/.bashrc` 或 `~/.zshrc` 中添加代理环境变量：

```bash
export WIN_HOST_IP=$(ip route show default | awk '{print $3}')
export PROXY_PORT=7890

export http_proxy="http://${WIN_HOST_IP}:${PROXY_PORT}"
export https_proxy="http://${WIN_HOST_IP}:${PROXY_PORT}"
export all_proxy="socks5://${WIN_HOST_IP}:${PROXY_PORT}"
```

在 Windows 管理员 PowerShell 中放行防火墙：

```powershell
New-NetFirewallRule -DisplayName "Allow WSL2 NAT Inbound" -Direction Inbound -InterfaceAlias "vEthernet (WSL*)" -Action Allow
```
