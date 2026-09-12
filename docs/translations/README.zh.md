# Killing Floor Bot Client

[English](../../README.md) · [Русский](./README.ru.md) · [Español](./README.es.md) · [Português](./README.pt.md) · [Lietuvių](./README.lt.md) · [Polski](./README.pl.md) · [Français](./README.fr.md) · **中文** · [日本語](./README.ja.md)

面向 Killing Floor（UE2.5）的外部 **L2Walker 风格** 无头客户端。通过 UDP 直接讲原生 Unreal Engine 2 网络协议——不启动游戏客户端，不做注入。以真实客户端身份连接，通过 Steam 认证，并进入游戏。

> 完整文档见 [`docs/`](../)：[USAGE](../USAGE.md) · [PROTOCOL](../PROTOCOL.md) · [GOTCHAS](../GOTCHAS.md) · [SERVER-SETUP](../SERVER-SETUP.md)。基于 Node.js（≥ 18）构建与运行；包管理器为 **pnpm**。`pnpm test` 运行测试套件。

## 从干净克隆开始引导（Windows）

Git 只保存 **源码**。所有下载内容——`node_modules`、32 位 node、koffi 二进制、Goldberg、Ghidra+JDK——都在 `.gitignore` 中，靠一条命令恢复：

```bash
node bootstrap.js          # core (pnpm) + --real-steam (32-bit node + koffi-ia32)
node bootstrap.js --all    # + Goldberg (own server) + Ghidra/JDK (reverse-engineering)
```

幂等（已安装的都会跳过）。需要联网和 7-Zip。随后 `pnpm test`。下载了什么、为什么下载，详见 [docs/USAGE.md](../USAGE.md)。

## GUI（经典 L2Walker 风格）

围绕 bot 的 Electron 桌面外壳——一个带 Start/Stop/Ready/Leave 工具栏、连接状态、配置标签页和日志的窗口。启动方式和 **分步指南（是否需要 Steam、操作顺序、spawn 注意事项）** 见 [GUI.md](GUI.md)：

```bash
pnpm install && pnpm start
```

## 目前可用的部分

| 层                                                     | 文件                       | 状态                                                                                |
| ------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------- |
| 位流（FBitReader/Writer、FString、FCompactIndex）      | `lib/bitstream.js`         | 完成 —— 56/56 往返测试                                                          |
| 数据包/bunch 分帧 + 控制通道                           | `lib/netconn.js`           | 完成 —— 19/19 自洽测试                                                    |
| **Phase 1** —— UDP MITM 中继 + 反汇编器                | `phase1_relay.js`          | 完成 —— 双向转发 + 反汇编（冒烟测试）                                  |
| **Phase 2** —— 握手客户端                              | `phase2_client.js`         | 完成 —— 对 mock 跑通完整状态机（10/10 e2e）；传输层已对真实服务器实机验证 |
| **Phase 3** —— `ServerRestartPlayer`（Ready）          | `phase2_client.js --ready` | 部分 —— RPC 发送正确（e2e）；通道/字段索引仍需抓包       |
| Steam 认证关卡（build 1065）                           | —                          | 受阻 —— 服务器强制 Steam GS 认证；需要 **服务器端的 Goldberg**（见下文）  |

### 实机验证对真实专用服务器（KF 1065 / engine 3339）

- **传输层已对真实引擎确认：** 客户端的 `HELLO` 被接受，我们的解码器干净地解析了真实服务器的控制文本。整套位流/数据包/bunch/FString 栈与真实 UE2.5 一致。
- **摸清了 KF 的 Steam 握手**（从服务器的 `Engine.dll` + 实时流量逆向得出）：`HELLO … STEAMID=%I64u` → 服务器 `STEAMENCRYPTIONKEY %s` → 客户端 `STEAMCLIENTBLOB SIZE/CHUNK/BLOB`（Steam 认证票据）→ 服务器 `SendUserConnectAndAuthenticate` → 异步 `OnGSClientApprove/Deny` → 之后才有 `CHALLENGE`。
- **Steam 认证是强制的。** 当服务器的 Steam 离线时（`SteamAPI_Init failed`，从未出现 `Connected to Steam Servers`），握手 **卡在 `STEAMCLIENTBLOB`**——没有 `CHALLENGE`，也不踢人。没有 `-nosteam`/insecure 之类的开关，自连的 SteamID 匹配也绕不过它。关卡之前的一切（传输、HELLO、控制解析）和之后的一切（`CHALLENGE→LOGIN→USES/HAVE→WELCOME→JOIN→ServerRestartPlayer`）都已实现；**只剩跨过 Steam 认证这一步。**

## 跨过 Steam 认证关卡 —— 服务器端 Goldberg（操作手册）

干净的做法（对你自己的服务器是合法的）：用 **Goldberg Steam Emulator** 的 `steam_api.dll` 运行专用服务器。Goldberg 的游戏服务器 `BeginAuthSession` 会立即批准任何票据，于是服务器在离线状态下也能走到 `OnGSClientApprove` 并继续到 `CHALLENGE`。随后 bot 的 `STEAMCLIENTBLOB`（任何非空、格式良好的 blob）就能通过，握手的其余部分照常运行。

1. 弄到一个可信的 Goldberg `steam_api.dll`（自行从源码构建，或用你信任的副本——别随便抓一个来路不明的二进制）。AppID 为 **1250**。
2. 在服务器的 `System/` 下，备份 `steam_api.dll`，放入 Goldberg 的版本，加上 `steam_appid.txt`=`1250`（已存在），如有需要再加 Goldberg 的 `steam_settings/`。
3. 重启服务器（`node launch-server.js` —— 默认指向项目内的 `_kfds/System` junction）。观察 `server.log`，确认 GS 认证在没有真实 Steam 连接的情况下激活。
4. 运行 bot：`node phase2_client.js --server 127.0.0.1:7707 --name Bot --ver 3339 --minver 3339 --blob <hex> --blob-size <n>` 预期 `CHALLENGE` → `LOGIN` → `USES`/`HAVE` → `WELCOME` → `JOIN` → 进入关卡。
5. 对于 Phase 3（Ready），用 `phase1_relay.js` 抓取 PlayerController 通道 + `ServerRestartPlayer` 索引（用真实客户端跑一次），再传 `--ready --pc-channel N --restart-index M`。

> 该服务器的引擎版本为 **3339**（不是 3369）—— 传 `--ver 3339 --minver 3339`。

支撑这一切的协议事实（已对真实 UT2004 v3369 引擎源码验证）：

- **控制通道是 ASCII 文本**，不是二进制枚举：`HELLO REVISION=0 MINVER=3180 VER=3369` → `CHALLENGE … CHALLENGE=<int> …` → `LOGIN RESPONSE=<int> URL=<url>` → `USES …`/`HAVE …` → `WELCOME` → `JOIN`。
- **登录认证只是一个简单的整数打乱**——没有 CD-key，没有 MD5，没有 Steam 票据：`RESPONSE = (Challenge*237) ^ 0x93fe92Ce ^ (Challenge>>16) ^ (Challenge<<16)`（UT2004 的 `UGameEngine::ChallengeResponse`）。已在 `phase2_client.js` 中实现。
- 传输是 **位流**：packet = `PacketId` 后跟各个 bunch；bunch 头 = `bControl/bOpen/bClose/bReliable/ChIndex/ChSeq/ChType/NumBits` + payload；末尾一个停止位。常量 `MAX_PACKETID=16384`、`MAX_CHSEQUENCE=1024`、`MAX_CHANNELS=1023`、`CHTYPE_Control=1/Actor=2/File=3`。

## 运行测试

```bash
pnpm test          # bitstream + netconn + relay smoke + handshake e2e
```

## 实机验证操作手册（需要真实游戏 —— 请自己动手）

以下步骤需要真实游戏运行，所以请自己动手，以对真实引擎做验证并抓取 Phase 3 的索引。

**1. 启动本地服务器**（无头，无 3D）：

```powershell
pwsh -File run-local-server.ps1            # KF-BioticsLab on udp/7707
```

（或从游戏菜单开一个 listen server：Host Game。）

**2a. 抓取一个真实客户端的握手**（ground truth + Phase 3 索引）：

```bash
node phase1_relay.js --listen 7708 --server 127.0.0.1:7707
```

然后在真实的 Killing Floor 控制台里：`open 127.0.0.1:7708`，选一个 perk，按 **Ready**。中继会把每个数据包（hexdump + 反汇编）记录到 `captures/`。留意：

- 确切的 `HELLO`/`CHALLENGE`/`LOGIN`/`USES`/`WELCOME`/`JOIN` 各行（确认我们的分帧能干净解出它们——如果反汇编干净，说明我们的编解码器与真实引擎一致）；
- JOIN 之后，服务器为你的 PlayerController 使用的 **actor 通道索引**，以及
- **你按下 Ready 时真实客户端发出的可靠 bunch**——其通道索引 = `--pc-channel`，其 payload 中打头的 packed int = `ServerRestartPlayer` 的 NetFields 函数索引 = `--restart-index`。

**2b. 直接对服务器试跑我们的无头客户端**：

```bash
node phase2_client.js --server 127.0.0.1:7707 --name Bot
# once you have the indices from 2a:
node phase2_client.js --server 127.0.0.1:7707 --name Bot --ready \
     --pc-channel <N> --restart-index <M>
```

如果服务器回 `FAILURE …`，消息会说明原因（密码、版本、GUID）。据此调整 `--ver/--minver`、`--url` 等再重试；客户端会把一切记录到 `captures/`。

## 客户端选项

```
--server host:port   target server (default 127.0.0.1:7707)
--name <str>         player name (default Bot)
--url <str>          login URL options (default "?Name=<name>")
--netspeed <n>       requested netspeed (default 10000); --no-netspeed to omit
--ver/--minver <n>   engine net version sent in HELLO (default 3369/3180)
--ready              after JOIN, send ServerRestartPlayer (needs the two indices below)
--pc-channel <n>     actor channel index of our PlayerController (from capture)
--restart-index <n>  NetFields index of ServerRestartPlayer (from capture)
--log <path>         capture log path
--quiet              don't echo to stdout
```

## 完全盲跑 Phase 3 还差什么

发送 Ready RPC 需要两个连接/build 相关的数字（PC 的 actor 通道，以及 `ServerRestartPlayer` 的 NetFields 索引），此外对于 `SelectVeterancy`，还需要 perk 类的 PackageMap 对象引用编码。这些都是确定的，但没有一次真实抓包（步骤 2a）就无从猜出。发送路径本身已实现，并由 e2e 测试证明；把抓到的索引接上去就闭环了。剩下最难啃的一块是 _解析入站的_ actor/属性复制（只有当 bot 必须对游戏状态做出反应时才需要——仅仅为了连接 + Ready 并不需要）。

## 免责声明

这是一个个人的逆向工程与协议互操作项目，为研究和教育目的发布。只对你自己拥有、或已获明确授权测试的服务器使用它。运行非官方客户端、逆向引擎、或生成 Steam 认证票据，可能违反游戏的 EULA 和 Steam 订户协议——你如何使用这份代码，责任完全在你自己。本项目 **按原样** 提供，不附带任何担保（见许可证）。与 Tripwire Interactive 或 Valve 无关联。

## 许可证

Copyright (c) 2026 TheBestPlan.

以 **GNU General Public License v3.0 or later**（GPL-3.0-or-later）发布。完整文本见 [LICENSE](../../LICENSE)。本程序是自由软件：你可以在上述条款下重新分发和/或修改它，且它 **不附带任何担保**。
