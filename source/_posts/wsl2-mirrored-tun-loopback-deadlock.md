---
title: WSL2 镜像网络与 TUN 冲突排查：物理网卡 Forwarding 引发的回路死锁
date: 2026-10-12 21:30:00
categories: 
  - 踩坑记录
  - 网络
tags: 
  - WSL2
  - TUN
  - Mihomo
  - 代理
  - Windows
---

在 WSL2 镜像网络（`networkingMode=mirrored`）环境下，配合 Windows 代理客户端（Clash Verge Rev / FlClash 等基于 Mihomo 内核的软件）开启 TUN 模式时，容易遇到一个严重的网络故障：一旦开启 TUN，节点测速全部显示 `Timeout`，国内外网页及直连流量全面断网。

排查后确认该问题由 WSL2 镜像网络动态修改宿主机物理网卡转发（Forwarding）配置引起。本文记录具体排查过程及最终的无感修复方案。

---

## 问题

* **主要症状**：
  * 仅开启**系统代理（System Proxy）**时，Windows 与 WSL2 均能正常连网与代理。
  * 一旦开启 **TUN 模式**，网络立刻全面瘫痪：
    * 代理客户端中所有节点延迟测速均显示 `Timeout`；
    * 浏览器访问国内网站或直连服务无限加载或连接重置；
    * WSL2 内的开发环境及 Docker 容器网络同步断连。
* **迷惑性表象**：
  * 重启代理客户端、重启系统或重新安装 TUN 驱动均无法恢复；
  * 更换客户端（Clash Verge Rev、FlClash）或切换 TUN 协议栈（gVisor / System / Mixed）表现一致；
  * 容易误判为节点失效、服务模式异常或驱动冲突。

---

## 本机环境

* **操作系统**：Windows 11 23H2 / 24H2 (x64)
* **WSL 配置**：WSL2 启用镜像网络（`.wslconfig` 中配置 `networkingMode=mirrored`, `dnsTunneling=true`）
* **开发环境**：WSL2 Ubuntu 24.04 + Docker Desktop (WSL2 Backend)
* **代理核心**：Mihomo (Clash Meta) 内核
* **物理网卡**：Realtek PCIe 千兆有线网卡 + Wi-Fi 6E 无线网卡

---

## 出现原因

该问题的本质是 **WSL2 镜像交换驱动（Host Network Service, HNS）**、**Windows TCP/IP 协议栈（tcpip.sys）** 与 **Mihomo 内核防回环死锁机制** 在三方交互下产生的逻辑冲突。

具体因果链条如下：

1. **HNS 动态启用物理网卡路由转发（IPv4 Forwarding）**：
   当 WSL2 配置为镜像网络模式（`networkingMode=mirrored`）时，Windows Host Network Service (HNS) 会在宿主机的物理出口网卡上挂载过滤驱动扩展。在此过程中，HNS 会在内存运行态（`ActiveStore`）中强制将该网卡的 IPv4 转发属性置为启用（`Forwarding: Enabled`）。
2. **DIRECT 直连流量回灌 TUN 网卡（Packet Re-entry）**：
   代理客户端启用 TUN 模式时，Mihomo 会向系统路由表注入高优先级路由（如 `0.0.0.0/1` 及 `128.0.0.0/1`）。对于规则判定为 DIRECT（直连）的出站流量，Mihomo 会将出站 Socket 绑定到物理网卡 IP。但由于物理网卡的 IPv4 处于 `Forwarding: Enabled` 状态，Windows TCP/IP 协议栈将发出的数据包误判为待路由转发数据，导致本应发往物理网关的数据包被重新路由回灌至 TUN 虚拟网卡接口。
3. **Mihomo 内核触发防回环保护并熔断连接**：
   Mihomo 收到来自 TUN 接口的入站流量后，检测到该连接与自身发起的 DIRECT 出站连接特征匹配，判定发生了流量回路（Loopback）。为避免数据包在物理网卡与 TUN 接口之间无限死循环导致系统资源耗尽，内核直接触发防死锁熔断保护，立刻拒绝并终止连接：
   ```log
   [TCP] dial DIRECT ... error: reject loopback connection to: ...
   ```
   所有 DIRECT 直连出站请求在数毫秒内被强制中断。
4. **级联故障导致全局超时**：
   由于直连链路被截断，包括直连的上游 DNS 解析在内的所有请求瞬间失败，引发客户端高频重试风暴并占满网络连接池，最终表现为节点延迟测速全部 `Timeout`、国内外网站均无法访问。

相关 Issue：
* [Mihomo Issue #3186](https://github.com/MetaCubeX/mihomo/issues/3186)（Windows 物理网卡开启 Forwarding 导致 TUN 回环）
* [Mihomo Feature #3229](https://github.com/MetaCubeX/mihomo/issues/3229)（针对 WSL 镜像网络动态启用 Forwarding 的处理提案）
* [microsoft/WSL #41652](https://github.com/microsoft/WSL/issues/41652)

---

## 复现

### 1. 检查物理网卡转发状态
以管理员身份在 PowerShell 中查看当前联网的物理网卡（如“以太网”）：
```powershell
netsh interface ipv4 show interface "以太网"
```
若输出中显示：
```text
Forwarding                         : enabled
```
即表明物理网卡处于开启转发状态。正常情况下，作为终端主机的物理网卡该属性应为 `disabled`。

### 2. 查看 Mihomo 运行日志
开启 TUN 模式，在终端发起一次直连请求：
```powershell
curl.exe -m 8 -v --noproxy "*" "http://www.baidu.com"
```
在代理客户端日志或内核输出中，会捕获到如下报错：
```json
{"type":"warning","payload":"[TCP] dial DIRECT (match DomainKeyword/baidu) ... error: reject loopback connection to: www.baidu.com:80"}
```
连接在十几毫秒内直接被断开。

---

## 修复

### 1. 临时手动修复
在 PowerShell 中手动关闭物理网卡的 IPv4 转发：
```powershell
Set-NetIPInterface -InterfaceAlias "以太网" -AddressFamily IPv4 -Forwarding Disabled -PolicyStore ActiveStore
```
执行后，DIRECT 直连请求立即恢复，节点延迟测速恢复正常，同时 WSL2 内的网络与代理不受影响（WSL2 镜像模式无需物理网卡开启转发）。

---

### 2. 状态复发原因
每次重启 WSL2 或启动 Docker 时，Windows HNS 会在后台再次将物理出口网卡的 Forwarding 置为 `Enabled`。
由于该配置由 HNS 动态写入内存运行态（`ActiveStore`），仅通过注册表或 `PersistentStore` 持久化修改无法彻底阻止其复发。

因此需要一套自动化机制，在每次启动 WSL 或网络变更时自动重置该状态。

---

### 3. 最终修复方案
为实现无感且稳定的修复，方案需满足以下条件：
1. **WSL 启动即时触发**：WSL 启动时立即执行禁用操作；
2. **完全静默无感知**：避免日常唤醒 WSL 或 Docker 时弹出 PowerShell 窗口抢焦点，通过 Windows Session 0 静默执行；
3. **多网卡自适应**：动态适配有线网卡与无线网卡切换场景。

#### 步骤一：配置 WSL 启动 Hook
在 WSL 的 `/etc/wsl.conf` 中追加 boot 命令。在 WSL 启动时调用 Windows 计划任务：
```ini
[boot]
systemd=true
command="/mnt/c/Windows/System32/schtasks.exe /run /tn DisableEthernetForwarding"
```

#### 步骤二：部署静默计划任务与动态脚本
在 Windows 中以管理员身份运行以下 PowerShell 脚本：

```powershell
# 1. 编写动态禁用转发脚本（过滤虚拟网卡，仅处理当前连接的物理网卡）
$scriptContent = @'
try {
    $interfaces = Get-NetIPInterface -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {
        $_.ConnectionState -eq 'Connected' -and
        $_.Forwarding -eq 'Enabled' -and
        $_.InterfaceAlias -notmatch 'vEthernet|Loopback|Mihomo|Tailscale|ZeroTier|VMware|Radmin|utun'
    }
    foreach ($if in $interfaces) {
        Set-NetIPInterface -InterfaceIndex $if.InterfaceIndex -AddressFamily IPv4 -Forwarding Disabled -PolicyStore ActiveStore -ErrorAction SilentlyContinue
        Set-NetIPInterface -InterfaceIndex $if.InterfaceIndex -AddressFamily IPv4 -Forwarding Disabled -PolicyStore PersistentStore -ErrorAction SilentlyContinue
    }
} catch {}
'@
Set-Content -Path "C:\ProgramData\DisableEthernetForwarding.ps1" -Value $scriptContent -Encoding UTF8 -Force

# 2. 注册为 SYSTEM 权限后台任务（开机启动 + 每小时轮询，Session 0 完全静默无弹窗）
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"C:\ProgramData\DisableEthernetForwarding.ps1`""
$triggerStartup = New-ScheduledTaskTrigger -AtStartup
$triggerStartup.Delay = "PT15S"
$triggerHourly = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName "DisableEthernetForwarding" -Action $action -Trigger @($triggerStartup, $triggerHourly) -Principal $principal -Settings $settings -Force | Out-Null

# 立即执行一次
& "C:\ProgramData\DisableEthernetForwarding.ps1"
Write-Host "部署完成！"
```

部署完成后，系统开机、WSL 启动或网络切换时，物理网卡转发均会被自动关闭，使 WSL2 镜像网络、Docker 与 Windows TUN 正常共存。
