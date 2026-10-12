---
title: WSL2 镜像网络与 Windows TUN 冲突排查：物理网卡 Forwarding 引发的回路死锁
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

# WSL2 镜像网络与 Windows TUN 冲突排查

在使用 WSL2 镜像网络（`networkingMode=mirrored`）配合 Windows 代理客户端（Clash Verge Rev / FlClash）开启 TUN 模式时，遇到了一起极度隐蔽的“全部节点超时 / 国内外全断网”故障。

记录此次排查的底层因果链条，以及最终实现的零感知自愈优化方案。

---

## 问题

* **主要症状**：
  * 开启**系统代理（System Proxy）**时，Windows 和 WSL2 均能正常上网及科学上网。
  * 一旦开启 **TUN 模式**，网络瞬间全面瘫痪：所有代理节点延迟测速显示 `Timeout`，浏览器访问国内网站（百度、B站、知乎）或直连服务全部转圈/连接重置，WSL2 内的 Agent 及容器网络同时中断。
* **极具迷惑性的表象**：
  * 重启客户端、重启电脑多次均无法解决；
  * 更换客户端（从 Clash Verge Rev 换到 FlClash）出现完全相同的崩溃；
  * 更换 TUN 协议栈（gVisor / System / Mixed）全部阵亡；
  * 容易让人误以为是“服务模式没装好”、“订阅节点失效”或“TUN 驱动冲突”。

---

## 本机环境

* **操作系统**：Windows 11 23H2 / 24H2 (x64)
* **WSL 配置**：WSL2 启用镜像网络（`.wslconfig` 包含 `networkingMode=mirrored`, `dnsTunneling=true`）
* **开发环境**：WSL2 Ubuntu 24.04 + Docker Desktop (WSL2 Backend)
* **代理核心**：Mihomo (Clash Meta) 内核（支持 sing-tun 数据面）
* **物理网卡**：Realtek PCIe GbE 有线网卡 + Wi-Fi 6E 无线网卡

---

## 出现原因

该问题本质上是 **WSL2 镜像交换驱动（HNS FSE）**、**Windows TCP/IP 协议栈** 与 **Mihomo 内核防死锁机制** 在三方边界碰撞下产生的架构级缺陷。

### 1. 根因链条

1. **WSL2 镜像网络的副作用**：
   在 `.wslconfig` 中配置 `networkingMode=mirrored` 时，Windows 的 Host Network Service (HNS) 会在物理网卡上挂载过滤扩展。在此过程中，HNS 会在内存运行态（`ActiveStore`）中**强制将物理上网网卡的 IPv4 转发开启（`Forwarding: Enabled`）**。
2. **TUN 出口数据包回灌（Self-Reentry）**：
   当代理软件开启 TUN 模式时，Mihomo 会向系统注入 TUN 路由（如 `0.0.0.0/1`）。当处理国内直连（DIRECT）流量时，Mihomo 虽然将出站 socket 显式绑定到了物理网卡 IP，但**因为物理网卡处于转发开启状态，Windows 协议栈将发出的数据包误判为待路由包，再次转发回灌进了 TUN 虚拟网卡**。
3. **内核防死锁机制瞬间断网**：
   Mihomo 侦测到刚从出站发出的数据包，作为全新的入站连接又从 TUN 钻了进来。为了防止无限循环导致系统死机，内核触发了防回环熔断保护：
   ```log
   [TCP] dial DIRECT ... error: reject loopback connection to: ...
   ```
   所有走 DIRECT 直连的出站连接在 12ms 内被内核掐死。
4. **重试风暴与全面超时**：
   由于国内直连流量和上游 DNS 查询全部被掐断，客户端陷入每秒数百次的重试风暴，进而导致整个网络拥塞、节点延迟测试全部超时。

### 2. 官方 Issue 对齐

此问题属于已被社区确认的底层缺陷：
* **Mihomo Issue**：[#3186](https://github.com/MetaCubeX/mihomo/issues/3186)（Windows 物理出口开启 Forwarding 导致 TUN 自回环）
* **Mihomo Feature**：[#3229](https://github.com/MetaCubeX/mihomo/issues/3229)（针对 WSL 镜像网络动态触发 Forwarding 的运行时熔断请求）
* **WSL 官方缺陷**：[microsoft/WSL#41652](https://github.com/microsoft/WSL/issues/41652)

---

## 复现

通过受控实验可以稳定复现该状态：

### 1. 验证网卡转发状态
在 PowerShell 中查看物理出口网卡（如“以太网”）：
```powershell
netsh interface ipv4 show interface "以太网"
```
若输出中显示：
```text
Forwarding                         : enabled
```
即满足复现条件。

### 2. 抓取内核回环报错
开启 TUN 模式，并在终端发起一次直连请求：
```powershell
curl.exe -m 8 -v --noproxy "*" "http://www.baidu.com"
```
查看 Mihomo 运行日志，会稳定捕获到大量如下报错，连接在十几毫秒内直接被 Reset：
```json
{"type":"warning","payload":"[TCP] dial DIRECT (match DomainKeyword/baidu) 172.21.160.233:6236(verge-mihomo.exe) --> www.baidu.com:80 error: reject loopback connection to: www.baidu.com:80"}
```

---

## 修复

### 1. 核心修复逻辑
将物理出口网卡的 IPv4 转发彻底关闭：
```powershell
Set-NetIPInterface -InterfaceAlias "以太网" -AddressFamily IPv4 -Forwarding Disabled -PolicyStore ActiveStore
```
关闭后，DIRECT 连接立即恢复（HTTP 200 / 302），节点测速恢复正常，同时 WSL2 内部的网络与代理访问依旧正常（WSL 镜像模式并不依赖物理网卡转发）。

---

### 2. 终极自愈优化方案

由于 WSL2 或 Docker 每次启动时，HNS 会在内存中再次将网卡置为 `Forwarding=Enabled`，仅执行一次命令会在下次启动 WSL 时复发。为此构建了**“三重防御闭环”**：

#### 闭环一：WSL 启动秒级自愈（消除时序死角）
在 WSL 的 `/etc/wsl.conf` 中追加引导命令。无论何时启动 WSL 或 Docker，启动后 0.1 秒内自动呼叫 Windows 计划任务纠正网卡：
```ini
[boot]
systemd=true
command="/mnt/c/Windows/System32/schtasks.exe /run /tn DisableEthernetForwarding"
```

#### 闭环二：Session 0 隔离静默执行（杜绝黑框闪烁与弹窗）
将任务所有者配置为 `NT AUTHORITY\SYSTEM`，放入 Windows Session 0 隔离会话中运行：
* **0 弹窗、0 黑框闪烁、0 抢焦点**；
* 拥有最高执行权限，免 UAC 确认。

#### 闭环三：多网卡动态适配
脚本不再硬编码单个网卡名称，自动动态扫描当前已连接的物理有线及无线网卡，适配网线/Wi-Fi 切换场景。

#### 最终部署脚本
以管理员身份运行以下 PowerShell 脚本完成部署：

```powershell
# 1. 编写动态禁用转发脚本
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

# 2. 注册 SYSTEM 级完全静默计划任务
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"C:\ProgramData\DisableEthernetForwarding.ps1`""
$triggerStartup = New-ScheduledTaskTrigger -AtStartup
$triggerStartup.Delay = "PT15S"
$triggerHourly = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName "DisableEthernetForwarding" -Action $action -Trigger @($triggerStartup, $triggerHourly) -Principal $principal -Settings $settings -Force | Out-Null
& "C:\ProgramData\DisableEthernetForwarding.ps1"
Write-Output "UPGRADE_SUCCESS"
```

至此，WSL2 镜像网络、Docker 开发环境与 Windows TUN 代理实现 100% 稳定共存。
