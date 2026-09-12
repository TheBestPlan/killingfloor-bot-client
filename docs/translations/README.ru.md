# Killing Floor Bot Client

[English](../../README.md) · **Русский** · [Español](./README.es.md) · [Português](./README.pt.md) · [Lietuvių](./README.lt.md) · [Polski](./README.pl.md) · [Français](./README.fr.md) · [中文](./README.zh.md) · [日本語](./README.ja.md)

Внешний headless-клиент для Killing Floor (UE2.5) в **стиле L2Walker**. Говорит на нативном сетевом протоколе Unreal Engine 2 поверх UDP — без запуска игрового клиента, без инъекций. Подключается как настоящий клиент, проходит Steam-авторизацию и входит в игру.

> Полная документация — в [`docs/`](../): [USAGE](../USAGE.md) · [PROTOCOL](../PROTOCOL.md) · [GOTCHAS](../GOTCHAS.md) · [SERVER-SETUP](../SERVER-SETUP.md). Сборка и запуск на Node.js (≥ 18); пакетный менеджер — **pnpm**. `pnpm test` запускает набор тестов.

## Развёртывание из чистого клона (Windows)

В Git лежит **только исходный код**. Всё, что скачивается — `node_modules`, 32-битный node, бинарники koffi, Goldberg, Ghidra+JDK — попадает под `.gitignore` и восстанавливается одной командой:

```bash
node bootstrap.js          # core (pnpm) + --real-steam (32-bit node + koffi-ia32)
node bootstrap.js --all    # + Goldberg (own server) + Ghidra/JDK (reverse-engineering)
```

Идемпотентно (всё уже установленное пропускается). Нужны интернет и 7-Zip. Затем `pnpm test`. Что и зачем скачивается — описано в [docs/USAGE.md](../USAGE.md).

## GUI (в классическом стиле L2Walker)

Настольная Electron-обёртка вокруг бота — окно с панелью Start/Stop/Ready/Leave, статусом подключения, вкладками конфигурации и логом. Запуск и **пошаговое руководство (нужен ли Steam, порядок действий, нюанс со спавном)** — в [GUI.md](GUI.md):

```bash
pnpm install && pnpm start
```

## Что работает сейчас

| Слой                                                   | Файл                       | Статус                                                                                |
| ------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------- |
| Битовый поток (FBitReader/Writer, FString, FCompactIndex) | `lib/bitstream.js`         | готово — 56/56 round-trip тестов                                                       |
| Кадрирование packet/bunch + управляющий канал          | `lib/netconn.js`           | готово — 19/19 тестов на самосогласованность                                          |
| **Фаза 1** — UDP MITM-релей + дизассемблер             | `phase1_relay.js`          | готово — пересылает в обе стороны + дизассемблирует (smoke-тест)                       |
| **Фаза 2** — клиент рукопожатия                        | `phase2_client.js`         | готово — полный конечный автомат против мока (10/10 e2e); транспорт проверен вживую на реальном сервере |
| **Фаза 3** — `ServerRestartPlayer` (Ready)             | `phase2_client.js --ready` | частично — RPC отправляется корректно (e2e); нужен захват для индексов канала/поля     |
| Барьер Steam-авторизации (build 1065)                  | —                          | заблокировано — сервер требует Steam GS-авторизацию; нужен **Goldberg на сервере** (см. ниже) |

### Проверка вживую на реальном выделенном сервере (KF 1065 / движок 3339)

- **Транспорт подтверждён на реальном движке:** `HELLO` клиента был принят, а наш декодер чисто разобрал управляющий текст реального сервера. Весь стек bit-stream/packet/bunch/FString совпадает с настоящим UE2.5.
- **Разобрано Steam-рукопожатие KF** (реверс из серверного `Engine.dll` + живой трафик): `HELLO … STEAMID=%I64u` → сервер `STEAMENCRYPTIONKEY %s` → клиент `STEAMCLIENTBLOB SIZE/CHUNK/BLOB` (тикет Steam-авторизации) → сервер `SendUserConnectAndAuthenticate` → асинхронно `OnGSClientApprove/Deny` → и только затем `CHALLENGE`.
- **Steam-авторизация обязательна.** Когда Steam на сервере офлайн (`SteamAPI_Init failed`, никогда `Connected to Steam Servers`), рукопожатие **застревает на `STEAMCLIENTBLOB`** — ни `CHALLENGE`, ни кика. Нет ни флага `-nosteam`/insecure, и совпадение SteamID при подключении к самому себе барьер не обходит. Всё до барьера (транспорт, HELLO, разбор управляющего канала) и после него (`CHALLENGE→LOGIN→USES/HAVE→WELCOME→JOIN→ServerRestartPlayer`) реализовано; **остаётся только пройти Steam-авторизацию.**

## Прохождение барьера Steam-авторизации — Goldberg на сервере (runbook)

Чистый способ (законный для сервера, которым вы владеете): запустить выделенный сервер с `steam_api.dll` от **Goldberg Steam Emulator**. Серверный `BeginAuthSession` у Goldberg одобряет любой тикет сразу, поэтому сервер доходит до `OnGSClientApprove` офлайн и переходит к `CHALLENGE`. Тогда `STEAMCLIENTBLOB` бота (любой непустой корректно сформированный blob) проходит, и остальная часть рукопожатия отрабатывает.

1. Возьмите доверенный `steam_api.dll` от Goldberg (соберите из исходников или используйте копию, которой доверяете — не хватайте случайный бинарник). AppID — **1250**.
2. В `System/` сервера сделайте резервную копию `steam_api.dll`, положите версию Goldberg, добавьте `steam_appid.txt`=`1250` (уже есть) и, при необходимости, `steam_settings/` от Goldberg.
3. Перезапустите сервер (`node launch-server.js` — по умолчанию использует внутрипроектный junction `_kfds/System`). Следите в `server.log` за активацией GS-авторизации без реального подключения к Steam.
4. Запустите бота: `node phase2_client.js --server 127.0.0.1:7707 --name Bot --ver 3339 --minver 3339 --blob <hex> --blob-size <n>` Ожидайте `CHALLENGE` → `LOGIN` → `USES`/`HAVE` → `WELCOME` → `JOIN` → на уровне.
5. Для Фазы 3 (Ready) захватите канал PlayerController и индекс `ServerRestartPlayer` с помощью `phase1_relay.js` (один раз прогоните через релей настоящий клиент) и передайте `--ready --pc-channel N --restart-index M`.

> Версия движка для этого сервера — **3339** (не 3369) — передавайте `--ver 3339 --minver 3339`.

Факты протокола, стоящие за этим (проверены по исходникам реального движка UT2004 v3369):

- **Управляющий канал — это ASCII-текст**, а не бинарный enum: `HELLO REVISION=0 MINVER=3180 VER=3369` → `CHALLENGE … CHALLENGE=<int> …` → `LOGIN RESPONSE=<int> URL=<url>` → `USES …`/`HAVE …` → `WELCOME` → `JOIN`.
- **Авторизация при входе — тривиальное перемешивание целых чисел** — без CD-ключа, без MD5, без Steam-тикета: `RESPONSE = (Challenge*237) ^ 0x93fe92Ce ^ (Challenge>>16) ^ (Challenge<<16)` (UT2004 `UGameEngine::ChallengeResponse`). Реализовано в `phase2_client.js`.
- Транспорт — это **битовый поток**: packet = `PacketId`, затем bunch'и; заголовок bunch = `bControl/bOpen/bClose/bReliable/ChIndex/ChSeq/ChType/NumBits` + payload; завершающий stop-бит. Константы `MAX_PACKETID=16384`, `MAX_CHSEQUENCE=1024`, `MAX_CHANNELS=1023`, `CHTYPE_Control=1/Actor=2/File=3`.

## Запуск тестов

```bash
pnpm test          # bitstream + netconn + relay smoke + handshake e2e
```

## Runbook проверки вживую (нужна настоящая игра — делайте сами)

Эти шаги требуют запущенной настоящей игры, поэтому выполните их сами, чтобы проверить на реальном движке и захватить индексы Фазы 3.

**1. Запустите локальный сервер** (headless, без 3D):

```powershell
pwsh -File run-local-server.ps1            # KF-BioticsLab on udp/7707
```

(или поднимите listen-сервер из меню игры: Host Game.)

**2a. Захватите рукопожатие НАСТОЯЩЕГО клиента** (эталон + индексы Фазы 3):

```bash
node phase1_relay.js --listen 7708 --server 127.0.0.1:7707
```

Затем в консоли настоящего Killing Floor: `open 127.0.0.1:7708`, выберите перк, нажмите **Ready**. Релей логирует каждый packet (hexdump + дизассемблирование) в `captures/`. Ищите:

- точные строки `HELLO`/`CHALLENGE`/`LOGIN`/`USES`/`WELCOME`/`JOIN` (подтвердите, что наше кадрирование декодирует их чисто — если дизассемблирование чистое, наш кодек совпадает с реальным движком);
- после JOIN — **индекс actor-канала**, который сервер использует для вашего PlayerController, и
- **надёжный (reliable) bunch, который ваш настоящий клиент отправляет при нажатии Ready** — его индекс канала = `--pc-channel`, а ведущий упакованный int в его payload = индекс функции `ServerRestartPlayer` в NetFields = `--restart-index`.

**2b. Попробуйте наш headless-клиент** напрямую против сервера:

```bash
node phase2_client.js --server 127.0.0.1:7707 --name Bot
# once you have the indices from 2a:
node phase2_client.js --server 127.0.0.1:7707 --name Bot --ready \
     --pc-channel <N> --restart-index <M>
```

Если сервер отвечает `FAILURE …`, в сообщении указана причина (пароль, версия, GUID). Поправьте `--ver/--minver`, `--url` и т. д. и повторите; клиент логирует всё в `captures/`.

## Опции клиента

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

## Что осталось для полностью «слепой» Фазы 3

Отправка Ready-RPC требует двух чисел, зависящих от подключения/сборки (actor-канал PC и индекс `ServerRestartPlayer` в NetFields), плюс, для `SelectVeterancy`, кодирование object-ref через PackageMap для класса перка. Они детерминированы, но не угадываемы без одного реального захвата (шаг 2a). Сам путь отправки реализован и подтверждён e2e-тестом; подстановка захваченных индексов замыкает цикл. Самое трудное из оставшегося — _разбор входящей_ репликации actor/property (нужен только если бот должен реагировать на состояние игры — не нужен просто чтобы подключиться + Ready).

## Отказ от ответственности

Это личный проект по обратной разработке и совместимости протоколов, опубликованный в исследовательских и образовательных целях. Используйте его только против серверов, которыми вы владеете или тестировать которые вам явно разрешено. Запуск неофициального клиента, реверс-инжиниринг движка или генерация Steam-тикетов авторизации могут нарушать EULA игры и Steam Subscriber Agreement — вы единолично отвечаете за то, как используете этот код. Он предоставляется **как есть**, без каких-либо гарантий (см. лицензию). Не связан с Tripwire Interactive или Valve.

## Лицензия

Copyright (c) 2026 TheBestPlan.

Распространяется под лицензией **GNU General Public License v3.0 or later** (GPL-3.0-or-later). Полный текст — в [LICENSE](../../LICENSE). Это свободное программное обеспечение: вы можете распространять и/или изменять его на этих условиях, и оно поставляется **без гарантий**.
