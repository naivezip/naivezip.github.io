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

最近把 WSL2 的网络模式换成了镜像网络（`networkingMode=mirrored`），配合宿主机代理软件（Clash Verge Rev / FlClash）开启 TUN 模式时，碰到了一个极其搞人的网络 bug：只要一开 TUN，节点测速全部超时，国内外网页全面断网。

排查了一圈发现是 WSL2 镜像网络动态修改了物理网卡配置导致的，记录一下排查过程和最终的无感自愈方案。

---

## 问题

* **主要症状**：
  * 只开普通**系统代理**时一切正常，Windows 和 WSL2 都能正常上网和翻墙。
  * 一旦开启 **TUN 模式**，网络立刻全面暴毙：
    * 代理软件里所有节点测速全部变成 `Timeout`；
    * 浏览器访问国内网站（百度、B站）或者直连服务无限转圈、连接重置；
    * WSL2 里的环境和容器网络也跟着断网。
* **极具迷惑性的表象**：
  * 重启代理客户端、重启电脑甚至重装 TUN 虚拟网卡驱动，完全没用；
  * 从 Clash Verge Rev 换到 FlClash（内核都是 Mihomo），更换 gVisor / System / Mixed 协议栈，死法完全一致；
  * 很容易让人误以为是服务模式没装好、节点挂了，或者 TUN 驱动冲突，排查方向很容易走偏。

---

## 本机环境

* **操作系统**：Windows 11 23H2 / 24H2 (x64)
* **WSL 配置**：WSL2 启用镜像网络（`.wslconfig` 中配置了 `networkingMode=mirrored`, `dnsTunneling=true`）
* **开发环境**：WSL2 Ubuntu 24.04 + Docker Desktop (WSL2 Backend)
* **代理核心**：Mihomo (Clash Meta) 内核
* **物理网卡**：Realtek PCIe 千兆有线网卡 + Wi-Fi 6E 无线网卡

---

## 出现原因

这个 bug 本质上是 **WSL2 镜像网络的底层机制**、**Windows TCP/IP 协议栈** 和 **Mihomo 内核防死锁机制** 撞到一起导致的回路死锁。

完整的因果链条如下：

1. **WSL2 镜像网络偷偷开启了网卡转发**：
   在 `.wslconfig` 中开启 `networkingMode=mirrored` 时，Windows 的 Host Network Service (HNS) 会在物理网卡上挂载过滤扩展。在这个过程中，HNS 会在内存运行态（`ActiveStore`）中**强制把物理上网网卡的 IPv4 转发打开（`Forwarding: Enabled`）**。
2. **直连数据包被二次转发回灌（Self-Reentry）**：
   代理开启 TUN 模式后，会向系统写入路由接管全局流量。
   当访问国内网站走直连（DIRECT）时，Mihomo 虽然把出站 socket 明确绑定到了物理网卡 IP，但由于**物理网卡处于转发开启状态，Windows 协议栈发出该数据包时，又把它当成需要路由转发的包，再次扔回了 TUN 虚拟网卡**。
3. **Mihomo 防死锁机制触发，直接掐断连接**：
   Mihomo 发现：刚刚才从物理网卡发出去的数据包，怎么又作为新连接从 TUN 网卡钻进来了？
   如果不做处理，数据包会在物理网卡和 TUN 之间无限死循环，直到系统打崩。因此 Mihomo 内核内置了防死锁熔断保护，只要抓到这种回环，当场掐断连接：
   ```log
   [TCP] dial DIRECT ... error: reject loopback connection to: ...
   ```
   所有直连流量在 10 几毫秒内直接被内核 Reset。
4. **重试风暴引发全面超时**：
   因为直连流量（包括上游 DNS 解析）被秒掐，客户端会疯狂重试，协议栈被塞满，最终导致所有代理节点测速全部超时，国内外网页全部打不开。

这个问题在社区里也是已知现象：
* [Mihomo Issue #3186](https://github.com/MetaCubeX/mihomo/issues/3186)（Windows 物理网卡开启 Forwarding 导致 TUN 回环）
* [Mihomo Feature #3229](https://github.com/MetaCubeX/mihomo/issues/3229)（针对 WSL 镜像网络动态触发 Forwarding 的讨论）
* [microsoft/WSL #41652](https://github.com/microsoft/WSL/issues/41652)

---

## 复现

要验证是不是踩了这个坑，排查步骤很简单：

### 1. 检查物理网卡转发状态
管理员身份打开 PowerShell，查看当前联网的物理网卡（如“以太网”）：
```powershell
netsh interface ipv4 show interface "以太网"
```
如果输出中显示：
```text
Forwarding                         : enabled
```
那就中招了。普通的终端电脑上网，网卡转发正常都应该是 `disabled`。

### 2. 查看 Mihomo 运行日志
保持 TUN 模式开启，在终端发起一个直连请求测试：
```powershell
curl.exe -m 8 -v --noproxy "*" "http://www.baidu.com"
```
去代理软件的日志里搜，或者看内核输出，会抓到大量类似报错：
```json
{"type":"warning","payload":"[TCP] dial DIRECT (match DomainKeyword/baidu) ... error: reject loopback connection to: www.baidu.com:80"}
```
连接在 10 多毫秒内直接被断掉。

---

## 修复

### 1. 临时手动修复
最直接的解决办法，就是手动把物理网卡的 IPv4 转发关掉：
```powershell
Set-NetIPInterface -InterfaceAlias "以太网" -AddressFamily IPv4 -Forwarding Disabled -PolicyStore ActiveStore
```
关掉之后，DIRECT 直连立刻恢复，节点测速恢复正常，同时 WSL2 内的网络和代理完全不受影响（镜像网络根本不需要物理网卡开转发）。

---

### 2. 为什么不能只改一次？
坑爹的地方在于：**只要 WSL2 重启或者 Docker 启动，Windows HNS 就会在后台再次把物理网卡的 Forwarding 改回 Enabled**。
而且就算改了注册表或者持久化配置（`PersistentStore`）也没用，HNS 是在内存运行态（`ActiveStore`）里动态修改的。

所以必须让系统在每次启动 WSL 或切换网络时，自动把网卡转发关掉。

---

### 3. 最终自愈方案
这里需要解决三个实际痛点：
1. **WSL 启动触发**：只要 WSL 启动，立刻关掉转发，不要有时差；
2. **彻底静默无感**：平时频繁开终端或者开 Docker，如果弹个 PowerShell 黑框出来抢焦点会非常恶心，必须在 Windows Session 0 静默后台运行；
3. **多网卡自适应**：笔记本经常在有线（以太网）和 Wi-Fi 之间切换，不能把网卡名写死。

具体操作如下：

#### 步骤一：配置 WSL 启动 Hook
在 WSL 的 `/etc/wsl.conf` 里加上 boot 命令。这样无论什么时候启动 WSL 或 Docker，启动后立刻通知 Windows 计划任务纠正网卡状态：
```ini
[boot]
systemd=true
command="/mnt/c/Windows/System32/schtasks.exe /run /tn DisableEthernetForwarding"
```

#### 步骤二：部署静默计划任务与动态脚本
在 Windows 上以管理员身份运行以下 PowerShell 脚本：

```powershell
# 1. 编写动态禁用转发脚本（过滤虚拟网卡，只针对当前已连接的物理网卡）
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

# 2. 注册为 SYSTEM 权限后台任务（开机自启 + 每小时轮询，Session 0 完全静默无弹窗）
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

配置好之后，不管是开机、WSL 启动，还是换 Wi-Fi，转发都会在后台被自动关掉。WSL2 镜像网络、Docker 和 Windows TUN 终于可以安稳共存了。
