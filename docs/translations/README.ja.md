# Killing Floor Bot Client

[English](../../README.md) · [Русский](./README.ru.md) · [Español](./README.es.md) · [Português](./README.pt.md) · [Lietuvių](./README.lt.md) · [Polski](./README.pl.md) · [Français](./README.fr.md) · [中文](./README.zh.md) · **日本語**

Killing Floor (UE2.5) 向けの外部 **L2Walker 方式** ヘッドレスクライアント。ネイティブな Unreal Engine 2 ネットワークプロトコルを UDP 上で直接話す — ゲームクライアントの起動も、インジェクションも不要。本物のクライアントとして接続し、Steam 認証を通過してゲームに入る。

> 完全なドキュメントは [`docs/`](../) にある: [USAGE](../USAGE.md) · [PROTOCOL](../PROTOCOL.md) · [GOTCHAS](../GOTCHAS.md) · [SERVER-SETUP](../SERVER-SETUP.md)。ビルドと実行は Node.js (≥ 18) 上、パッケージマネージャは **pnpm**。`pnpm test` でスイートを走らせる。

## クリーンクローンからのブートストラップ (Windows)

Git が保持するのは **ソースのみ**。ダウンロードされるもの — `node_modules`、32-bit node、koffi バイナリ、Goldberg、Ghidra+JDK — はすべて `.gitignore` 下にあり、コマンド一つで復元される:

```bash
node bootstrap.js          # core (pnpm) + --real-steam (32-bit node + koffi-ia32)
node bootstrap.js --all    # + Goldberg (own server) + Ghidra/JDK (reverse-engineering)
```

冪等 (インストール済みのものはスキップされる)。インターネットと 7-Zip が必要。その後 `pnpm test`。何がなぜダウンロードされるかは [docs/USAGE.md](../USAGE.md) に記載。

## GUI (クラシックな L2Walker スタイル)

ボットを包む Electron デスクトップラッパー — Start/Stop/Ready/Leave ツールバー、接続ステータス、設定タブ、ログを備えたウィンドウ。起動方法と **ステップバイステップのガイド (Steam が必要か、作業順序、spawn の注意点)** は [GUI.md](GUI.md) にある:

```bash
pnpm install && pnpm start
```

## 現時点で動くもの

| レイヤー                                                  | ファイル                       | ステータス                                                                                |
| ------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------- |
| ビットストリーム (FBitReader/Writer, FString, FCompactIndex) | `lib/bitstream.js`         | done — 56/56 ラウンドトリップテスト                                                          |
| パケット/bunch フレーミング + コントロールチャネル                 | `lib/netconn.js`           | done — 19/19 自己整合性テスト                                                    |
| **Phase 1** — UDP MITM リレー + ディスアセンブラ            | `phase1_relay.js`          | done — 双方向転送 + ディスアセンブル (スモークテスト)                                  |
| **Phase 2** — ハンドシェイククライアント                       | `phase2_client.js`         | done — モックに対する完全なステートマシン (10/10 e2e)、トランスポートは実サーバーに対しライブ検証済み |
| **Phase 3** — `ServerRestartPlayer` (Ready)            | `phase2_client.js --ready` | partial — RPC は正しく送出 (e2e)、チャネル/フィールドインデックスにはキャプチャが必要       |
| Steam 認証ゲート (build 1065)                           | —                          | blocked — サーバーが Steam GS 認証を強制、**サーバー側の Goldberg** が必要 (下記参照)  |

### ライブ検証 実際の専用サーバーに対して (KF 1065 / engine 3339)

- **実エンジンに対してトランスポートを確認:** クライアントの `HELLO` は受理され、我々のデコーダは実サーバーのコントロールテキストをきれいにパースした。ビットストリーム/パケット/bunch/FString スタック全体が実際の UE2.5 と一致する。
- **KF Steam ハンドシェイクを解明** (サーバーの `Engine.dll` + ライブトラフィックからリバース): `HELLO … STEAMID=%I64u` → サーバー `STEAMENCRYPTIONKEY %s` → クライアント `STEAMCLIENTBLOB SIZE/CHUNK/BLOB` (Steam 認証チケット) → サーバー `SendUserConnectAndAuthenticate` → 非同期 `OnGSClientApprove/Deny` → その後にようやく `CHALLENGE`。
- **Steam 認証は強制される。** サーバーの Steam がオフライン (`SteamAPI_Init failed`、`Connected to Steam Servers` にならない) だと、ハンドシェイクは **`STEAMCLIENTBLOB` で停止** — `CHALLENGE` も来ず、キックもされない。`-nosteam`/insecure フラグは存在せず、自己接続 SteamID の一致でも回避できない。ゲートより前 (トランスポート、HELLO、コントロールパース) と後 (`CHALLENGE→LOGIN→USES/HAVE→WELCOME→JOIN→ServerRestartPlayer`) はすべて実装済み。**残るは Steam 認証を越えることだけ。**

## Steam 認証ゲートを越える — サーバー側の Goldberg (runbook)

クリーンな方法 (自分が所有するサーバーには正当): 専用サーバーを **Goldberg Steam Emulator** の `steam_api.dll` で走らせる。Goldberg のゲームサーバー `BeginAuthSession` は任意のチケットを即座に承認するため、サーバーはオフラインでも `OnGSClientApprove` に到達し `CHALLENGE` へ進む。すると ボットの `STEAMCLIENTBLOB` (空でなく、整った blob であれば何でもよい) が通り、ハンドシェイクの残りが走る。

1. 信頼できる Goldberg `steam_api.dll` を入手する (ソースからビルドするか、信頼できるコピーを使う — 素性の知れないバイナリを拾ってこない)。AppID は **1250**。
2. サーバーの `System/` で `steam_api.dll` をバックアップし、Goldberg のものを置き、`steam_appid.txt`=`1250` を追加 (既に存在)、必要なら Goldberg の `steam_settings/` も追加する。
3. サーバーを再起動する (`node launch-server.js` — デフォルトはプロジェクト内の `_kfds/System` ジャンクション)。`server.log` を見て、実際の Steam 接続なしに GS 認証が有効化されるのを確認する。
4. ボットを実行する: `node phase2_client.js --server 127.0.0.1:7707 --name Bot --ver 3339 --minver 3339 --blob <hex> --blob-size <n>` 期待される流れは `CHALLENGE` → `LOGIN` → `USES`/`HAVE` → `WELCOME` → `JOIN` → in-level。
5. Phase 3 (Ready) では、`phase1_relay.js` で PlayerController チャネル + `ServerRestartPlayer` インデックスをキャプチャし (実クライアントを一度ルーティング)、`--ready --pc-channel N --restart-index M` を渡す。

> このサーバーのエンジンバージョンは **3339** (3369 ではない) — `--ver 3339 --minver 3339` を渡すこと。

その背後にあるプロトコルの事実 (実際の UT2004 v3369 エンジンソースに対して検証済み):

- **コントロールチャネルは ASCII テキスト** で、バイナリ enum ではない: `HELLO REVISION=0 MINVER=3180 VER=3369` → `CHALLENGE … CHALLENGE=<int> …` → `LOGIN RESPONSE=<int> URL=<url>` → `USES …`/`HAVE …` → `WELCOME` → `JOIN`。
- **ログイン認証は単純な整数スクランブル** — CD-key も MD5 も Steam チケットもない: `RESPONSE = (Challenge*237) ^ 0x93fe92Ce ^ (Challenge>>16) ^ (Challenge<<16)` (UT2004 `UGameEngine::ChallengeResponse`)。`phase2_client.js` に実装。
- トランスポートは **ビットストリーム**: packet = `PacketId` に続いて bunches、bunch ヘッダ = `bControl/bOpen/bClose/bReliable/ChIndex/ChSeq/ChType/NumBits` + ペイロード、末尾に stop ビット。定数 `MAX_PACKETID=16384`、`MAX_CHSEQUENCE=1024`、`MAX_CHANNELS=1023`、`CHTYPE_Control=1/Actor=2/File=3`。

## テストの実行

```bash
pnpm test          # bitstream + netconn + relay smoke + handshake e2e
```

## ライブ検証 runbook (実ゲームが必要 — 自分でやる)

これらの手順には実ゲームの稼働が必要なので、実エンジンに対する検証と Phase 3 インデックスのキャプチャは自分でやること。

**1. ローカルサーバーを起動する** (ヘッドレス、3D なし):

```powershell
pwsh -File run-local-server.ps1            # KF-BioticsLab on udp/7707
```

(またはゲームメニューから listen サーバーをホストする: Host Game。)

**2a. 実クライアントのハンドシェイクをキャプチャする** (グラウンドトゥルース + Phase 3 インデックス):

```bash
node phase1_relay.js --listen 7708 --server 127.0.0.1:7707
```

次に実際の Killing Floor コンソールで: `open 127.0.0.1:7708`、perk を選び、**Ready** を押す。リレーは全パケット (hexdump + ディスアセンブリ) を `captures/` にログする。探すもの:

- 正確な `HELLO`/`CHALLENGE`/`LOGIN`/`USES`/`WELCOME`/`JOIN` の各行 (我々のフレーミングがそれらをきれいにデコードできるか確認 — ディスアセンブリがクリーンなら、我々のコーデックは実エンジンと一致している);
- JOIN の後、サーバーがあなたの PlayerController に使う **アクターチャネルインデックス**、そして
- **Ready を押したときに実クライアントが送る reliable bunch** — そのチャネルインデックス = `--pc-channel`、ペイロード先頭の packed int = `ServerRestartPlayer` NetFields 関数インデックス = `--restart-index`。

**2b. 我々のヘッドレスクライアントを試す** サーバーに直接:

```bash
node phase2_client.js --server 127.0.0.1:7707 --name Bot
# 2a でインデックスを得たら:
node phase2_client.js --server 127.0.0.1:7707 --name Bot --ready \
     --pc-channel <N> --restart-index <M>
```

サーバーが `FAILURE …` を返す場合、メッセージが理由を告げる (password、version、GUID)。`--ver/--minver`、`--url` などを調整して再試行、クライアントはすべてを `captures/` にログする。

## クライアントオプション

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

## 完全ブラインドな Phase 3 に残された課題

Ready RPC の送信には、接続/ビルド固有の 2 つの数値 (PC アクターチャネルと `ServerRestartPlayer` NetFields インデックス) が必要で、さらに `SelectVeterancy` のためには perk クラスの PackageMap object-ref エンコーディングが要る。これらは決定論的だが、実キャプチャ (手順 2a) なしには推測できない。送信パス自体は実装済みで e2e テストにより実証されている。キャプチャしたインデックスを配線すればループが閉じる。残る最も難しい部分は _インバウンドの_ アクター/プロパティ複製の **パース** だ (ボットがゲーム状態に反応する必要がある場合にのみ必要 — 単に接続 + Ready するだけなら不要)。

## 免責事項

これは個人的なリバースエンジニアリングおよびプロトコル相互運用のプロジェクトであり、研究・教育目的で公開されている。自分が所有するか、明示的にテストを許可されたサーバーに対してのみ使用すること。非公式クライアントの実行、エンジンのリバースエンジニアリング、Steam 認証チケットの生成は、ゲームの EULA および Steam Subscriber Agreement に違反する可能性がある — このコードをどう使うかの責任はあなた一人にある。本ソフトウェアは **現状のまま** 提供され、いかなる保証もない (ライセンスを参照)。Tripwire Interactive とも Valve とも無関係。

## ライセンス

Copyright (c) 2026 TheBestPlan.

**GNU General Public License v3.0 or later** (GPL-3.0-or-later) の下でリリースされる。全文は [LICENSE](../../LICENSE) を参照。本プログラムはフリーソフトウェアである: これらの条項の下で再頒布および改変ができ、**無保証** で提供される。
