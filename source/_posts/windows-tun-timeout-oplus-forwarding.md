---
title: Windows 下 TUN 模式全节点超时排查：O+ Connect 开启网卡转发引发的回环
date: 2026-11-14 21:30:00
categories: 
  - 网络
tags: 
  - TUN
  - Mihomo
  - Windows
---

在 Windows 下开启 Clash Verge（`2.5.10`，Mihomo 内核 `v1.19.33`）的 TUN 模式后，遇到所有节点测速全部超时、网页完全打不开的问题。但只要关掉 TUN 切回系统代理（`127.0.0.1:7897`），不管是网页直连、上游 DNS 解析还是节点延迟测试全都正常。

途中我还切到 **v2rayN** 试了一下，想排除是不是客户端或者 Mihomo 内核本身的 Bug，结果在 v2rayN 下开启 TUN 同样复现故障。这说明问题出在系统的网络环境上，跟具体用哪个代理内核无关。

最终排查发现，还是开启了网络转发导致的问题。

----

## 日志定位

正常情况下，应用流量进入 TUN 网卡后，代理核心发往上游 DNS 和节点服务器的出站连接应该从物理网卡（`WLAN`）发出去。

但翻看 Clash 核心日志发现，**Mihomo 自己发出的出站连接又重新掉进了自己的 TUN 网卡里**：

* `16:04:41.430`：Mihomo 正常识别到默认物理出口 `default interface changed by monitor, => WLAN`
* `16:04:43.055`：TUN 网卡（`Mihomo`，`auto route: true`，`gVisor` 栈）创建完成
* `16:04:43.078`：**TUN 启动仅 23 毫秒后**，来源进程为 `verge-mihomo.exe` 自身、发往 `1.12.12.12:443` 和 `223.5.5.5:443` 的 DNS 请求就回流进了 TUN，触发核心报错：
  ```text
  reject loopback connection
  ```
* `16:04:43.080` 起：来源进程 `verge-mihomo.exe` 访问各个节点真实 IP 的连接也被核心当成入站流量再次拦截处理；后续甚至出现节点域名解析受 Fake-IP 回流污染、直接向 `198.18.0.13:11005` 拨号的记录。

从日志快照里按时间段统计，开关 TUN 的相关性非常明显：

| 时段 | `verge-mihomo.exe` 作为来源进程的日志数 | `reject loopback` 报错数 |
|---|---:|---:|
| `16:04:11–16:04:43`（第一次开 TUN 前） | 0 | 0 |
| `16:04:43–16:04:52`（第一次开 TUN，约 9 秒） | 3,044 | 670 |
| `16:05:11–16:05:26`（第二次开 TUN，约 15 秒） | 94 | 19 |
| `16:05:37` 之后（关闭 TUN 且挂起请求结束后） | 0 | 0 |

----

## 幕后真凶：O+ Connect 偷偷开启了所有网卡的 Forwarding

之前排查 WSL2 镜像网络时就踩过物理网卡 `Forwarding=Enabled` 的坑，但我早已把 WSL2 切回了默认的 `nat` 模式。查了一下当前 `WLAN`（InterfaceIndex 26）的状态，`Forwarding` 竟然又是 `Enabled`。

对比同一时段的第三方软件日志，抓到了这次修改转发状态的真凶——**O+ Connect**（服务名 `O+Connect Service`，程序路径 `D:\Oppo Connect\daemon\devicespace.exe`）：

1. `16:04:14.941`：O+ Connect 日志记录 `WinTun: Creating new adapter utun8`，创建了它自己的虚拟网卡。
2. `16:04:29.058`：O+ Connect 日志明确记录 `Enabled IPv4 forwarding on InterfaceIndex 26`。它不仅开了 `utun8` 的转发，还顺手把回环、`WLAN`、`以太网`、VMware、Radmin 等接口的 IPv4 转发全打开了。
3. **最隐蔽的一点**：`16:13:58` 时 Windows 记录 `utun8` 断开，随后的网络快照里 `utun8` 这张网卡已经彻底消失了，**但它给 `WLAN` 和 `以太网` 开启的 `Forwarding=Enabled` 状态依然残留在系统里**。

也就是说，哪怕关掉或卸载了 O+ Connect、`utun8` 网卡已经消失，物理网卡的转发状态也不会自动恢复。

----

## 为什么关掉 IPv4 转发就能彻底恢复？（底层机制）

手动把 `WLAN` 的 `Forwarding` 改回 `Disabled` 后，TUN 模式立刻恢复正常。为什么物理网卡开个转发，就会让所有代理内核（Mihomo / v2rayN）的 TUN 模式集体死锁？

原因在于 **Windows 内核协议栈（`tcpip.sys`）的跨网卡转发逻辑**与代理内核 **`IP_UNICAST_IF` 绑定机制**发生了冲突：

1. **代理内核如何防回环**：
   开启 TUN（`auto-route: true`）后，代理软件会向系统路由表注入 `0.0.0.0/1` 和 `128.0.0.0/1`。因为 `/1` 前缀比物理网卡的默认路由 `0.0.0.0/0` 更长（遵循最长前缀匹配原则），全机所有公网流量都会被吸进 TUN 网卡。
   为了防止代理核心**自己发出的出站包**也被吸进 TUN，Windows 下的代理内核都会调用 Winsock 的 `IP_UNICAST_IF` 选项，将核心自己的出站 Socket 强制绑定在物理网卡（`WLAN`）上。
2. **`Forwarding = Disabled`（终端主机模式）时**：
   Windows 禁止 `WLAN` 将数据包跨网卡转发给其他接口。通过 `IP_UNICAST_IF` 绑在 `WLAN` 上的出站包，只会在 `WLAN` 自身的路由表中匹配默认网关（`192.168.1.1`），顺利从物理路由器发出。
3. **`Forwarding = Enabled`（路由器转发模式）时**：
   一旦物理网卡开启了 IPv4 转发，Windows 内核就允许这张网卡上的流量**根据全局路由表跨网卡转发**。当代理核心把包发到 `WLAN` 上时，`tcpip.sys` 发现目标 IP 不在局域网内，且全局路由表里 TUN 网卡的 `0.0.0.0/1` 比 `WLAN` 的 `0.0.0.0/0` 优先级更高，于是**直接在内核里把这个包从 `WLAN` 跨网卡转发进了 `Mihomo` TUN 网卡**！

用 ASCII 图表示两者的区别如下：

```text
[ 1. 正常状态：WLAN Forwarding = Disabled（终端主机模式） ]

  浏览器 / 应用
       │ 1. 匹配全局路由 0.0.0.0/1
       ▼
┌─────────────────┐      2. 代理核心发起出站连接       ┌──────────────────────┐
│  Mihomo TUN 网卡 │ ───────────────────────────────► │  verge-mihomo.exe    │
│ (198.18.0.1/16) │                                  │ (通过 IP_UNICAST_IF   │
└─────────────────┘                                  │  强制绑定到 WLAN:26) │
                                                     └──────────┬───────────┘
                                                                │ 3. 转发关闭，仅查 WLAN 自身路由
                                                                ▼
                                                     ┌──────────────────────┐
                                                     │   物理网卡 WLAN (26)  │
                                                     │  Forwarding=Disabled │
                                                     └──────────┬───────────┘
                                                                │ 4. 走默认网关 192.168.1.1
                                                                ▼
                                                        DNS 上游 / 代理节点


[ 2. 故障状态：O+ Connect 将 WLAN 设为 Forwarding = Enabled（路由转发模式） ]

  浏览器 / 应用
       │ 1. 匹配全局路由 0.0.0.0/1
       ▼
┌─────────────────┐      2. 代理核心发起出站连接       ┌──────────────────────┐
│  Mihomo TUN 网卡 │ ───────────────────────────────► │  verge-mihomo.exe    │
│ (0.0.0.0/1 路由) │                                  │ (通过 IP_UNICAST_IF   │
└────────▲────────┘                                  │  绑定到 WLAN:26)     │
         │                                           └──────────┬───────────┘
         │ 4. tcpip.sys 允许跨网卡转发！                         │ 3. 送入 WLAN 协议栈
         │    全局路由表中 TUN 的 0.0.0.0/1                      ▼
         │    比 WLAN 的 0.0.0.0/0 前缀更长，         ┌──────────────────────┐
         │    数据包在内核直接被跨网卡转发回 TUN！     │   物理网卡 WLAN (26)  │
         └────────────────────────────────────────── │  Forwarding=Enabled  │
                                                     └──────────────────────┘
         │
         ▼ 5. 23ms 内包回到 Mihomo，核心发现来源进程是自己：
              触发 "reject loopback connection" 熔断 / 全节点超时！
```

相关 Issue 参考：[Mihomo #3186](https://github.com/MetaCubeX/mihomo/issues/3186)、[Mihomo #1664](https://github.com/MetaCubeX/mihomo/issues/1664)。

----

## 顺带排除的其他干扰项与端口隐患

机器上还装了不少虚拟网卡和驱动，排查时顺手做了一轮核对，确认以下都不是本次故障的原因，无需盲目卸载：

* **Radmin VPN / Tailscale / VMware / Hyper-V**：Radmin 默认路由跃点数为 `9257`（`WLAN` 为 `35`），未抢占默认出口；其余虚拟网卡网段与局域网及 Fake-IP（`198.18.0.0/16`）均无冲突。
* **Windows ICS (`SharedAccess`)**：虽然监听了 `0.0.0.0:53/UDP`，但实测本机 DNS 响应正常，核心无绑定报错。
* **雷神 / 迅雷 WFP 过滤驱动**：`nfwfp.sys` 和 `XLWFP.sys` 处于 `Running` 状态，但未拦截此次连接。

不过体检时顺带揪出了另一个**独立隐患**：本机 IPv4 TCP 动态端口范围被改成了 `1024–15000`（注册表 `MaxUserPort=15000`，Windows 默认应为 `49152–65535`），导致当天下午系统日志报过三次 `Tcpip` 事件 `4227`（本地端口复用压力）。虽然它不是引发 TUN 回环的元凶，但会在高频重试时加剧故障，建议一并恢复。

----

## 最优解决方案

### 1. 彻底关闭所有物理网卡（WLAN + 以太网）的 IPv4 转发

因为 O+ Connect 当时把所有网卡的转发都打开了，除了当前连着的 `WLAN`，处于断开状态的 `以太网` 也会残留 `Forwarding=Enabled`（下次插网线又会复发）。

在管理员 PowerShell 中一次性把无线和有线物理网卡的运行态（`ActiveStore`）与持久态（`PersistentStore`）转发全部关闭：

```powershell
Get-NetIPInterface -AddressFamily IPv4 |
    Where-Object { $_.InterfaceAlias -in @('WLAN', '以太网') } |
    ForEach-Object {
        Set-NetIPInterface -InterfaceIndex $_.InterfaceIndex -AddressFamily IPv4 -Forwarding Disabled -PolicyStore ActiveStore
        Set-NetIPInterface -InterfaceIndex $_.InterfaceIndex -AddressFamily IPv4 -Forwarding Disabled -PolicyStore PersistentStore
    }

# 复核物理网卡状态
Get-NetIPInterface -AddressFamily IPv4 |
    Where-Object { $_.InterfaceAlias -in @('WLAN', '以太网') } |
    Select-Object InterfaceIndex, InterfaceAlias, ConnectionState, Forwarding
```

### 2. 清理触发源（O+ Connect）

卸载 O+ Connect，或在 `services.msc` 中将 `O+Connect Service`（`D:\Oppo Connect\daemon\devicespace.exe`）禁用，防止它开机自启后再次把所有网卡的 `Forwarding` 改回 `Enabled`。只要清理掉这个源头（且 WSL2 保持 `nat` 模式），就不需要挂任何后台轮询脚本。

### 3. 恢复 Windows 默认 TCP 动态端口范围

顺手删掉被篡改的 `MaxUserPort` 注册表项，将动态端口范围恢复为微软默认的 `49152–65535`：

```powershell
Remove-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters" -Name "MaxUserPort" -ErrorAction SilentlyContinue
netsh int ipv4 set dynamicport tcp start=49152 num=16384
```
