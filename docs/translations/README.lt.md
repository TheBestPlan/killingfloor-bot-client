# Killing Floor Bot Client

[English](../../README.md) · [Русский](./README.ru.md) · [Español](./README.es.md) · [Português](./README.pt.md) · **Lietuvių** · [Polski](./README.pl.md) · [Français](./README.fr.md) · [中文](./README.zh.md) · [日本語](./README.ja.md)

Išorinis, **L2Walker stiliaus** headless klientas skirtas Killing Floor (UE2.5). Kalba natyviu Unreal Engine 2 tinklo protokolu per UDP — jokio žaidimo kliento paleidimo, jokios injekcijos. Prisijungia kaip tikras klientas, praeina Steam autentifikaciją ir įeina į žaidimą.

> Pilna dokumentacija yra [`docs/`](../): [USAGE](../USAGE.md) · [PROTOCOL](../PROTOCOL.md) · [GOTCHAS](../GOTCHAS.md) · [SERVER-SETUP](../SERVER-SETUP.md). Kuriamas ir paleidžiamas su Node.js (≥ 18); paketų tvarkyklė — **pnpm**. `pnpm test` paleidžia visą testų rinkinį.

## Bootstrap iš švaraus klono (Windows)

Git laiko **tik šaltinį**. Viskas, kas parsisiunčiama — `node_modules`, 32 bitų node, koffi binariniai failai, Goldberg, Ghidra+JDK — yra `.gitignore` sąraše ir atkuriama viena komanda:

```bash
node bootstrap.js          # core (pnpm) + --real-steam (32-bit node + koffi-ia32)
node bootstrap.js --all    # + Goldberg (own server) + Ghidra/JDK (reverse-engineering)
```

Idempotentinis (viskas, kas jau įdiegta, praleidžiama). Reikia interneto ir 7-Zip. Tada `pnpm test`. Kas ir kodėl parsisiunčiama, aprašyta [docs/USAGE.md](../USAGE.md).

## GUI (klasikinis L2Walker stilius)

Electron darbalaukio apvalkalas aplink botą — langas su Start/Stop/Ready/Leave įrankių juosta, prisijungimo būsena, konfigūracijos skirtukai ir žurnalas. Paleidimas ir **žingsnis po žingsnio vadovas (ar reikia Steam, kokia darbo eiga, spawn niuansas)** yra [GUI.md](GUI.md):

```bash
pnpm install && pnpm start
```

## Kas veikia šiandien

| Sluoksnis                                              | Failas                     | Būsena                                                                                |
| ------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------- |
| Bit-stream (FBitReader/Writer, FString, FCompactIndex) | `lib/bitstream.js`         | atlikta — 56/56 round-trip testai                                                     |
| Paketų/bunch kadravimas + valdymo kanalas              | `lib/netconn.js`           | atlikta — 19/19 self-consistency testai                                              |
| **Phase 1** — UDP MITM relay + disasembleris           | `phase1_relay.js`          | atlikta — persiunčia į abi puses + disasembliuoja (smoke test)                        |
| **Phase 2** — handshake klientas                       | `phase2_client.js`         | atlikta — pilna būsenų mašina prieš mock (10/10 e2e); transportas gyvai patvirtintas prieš tikrą serverį |
| **Phase 3** — `ServerRestartPlayer` (Ready)            | `phase2_client.js --ready` | dalinai — RPC išsiunčiamas teisingai (e2e); reikia capture kanalo/lauko indeksui       |
| Steam-auth barjeras (build 1065)                       | —                          | užblokuota — serveris reikalauja Steam GS auth; reikia **Goldberg serveryje** (žr. žemiau)  |

### Gyvas patvirtinimas prieš tikrą dedikuotą serverį (KF 1065 / engine 3339)

- **Transportas patvirtintas prieš tikrą variklį:** kliento `HELLO` buvo priimtas ir mūsų dekoderis švariai išanalizavo tikro serverio valdymo tekstą. Visas bit-stream/paketų/bunch/FString stekas atitinka tikrą UE2.5.
- **Atrastas KF Steam handshake** (reversuotas iš serverio `Engine.dll` + gyvo srauto): `HELLO … STEAMID=%I64u` → serveris `STEAMENCRYPTIONKEY %s` → klientas `STEAMCLIENTBLOB SIZE/CHUNK/BLOB` (Steam auth bilietas) → serveris `SendUserConnectAndAuthenticate` → asinchroniškai `OnGSClientApprove/Deny` → tik tada `CHALLENGE`.
- **Steam auth yra privaloma.** Kai serverio Steam yra offline (`SteamAPI_Init failed`, niekada `Connected to Steam Servers`), handshake **užstringa ties `STEAMCLIENTBLOB`** — jokio `CHALLENGE`, jokio kick. Nėra `-nosteam`/insecure vėliavos, o savęs prisijungimo SteamID sutapimas jo neapeina. Viskas prieš barjerą (transportas, HELLO, valdymo parsinimas) ir po jo (`CHALLENGE→LOGIN→USES/HAVE→WELCOME→JOIN→ServerRestartPlayer`) yra įgyvendinta; **lieka tik peržengti Steam auth.**

## Steam-auth barjero peržengimas — Goldberg serveryje (runbook)

Švarus būdas (teisėtas serveriui, kurį valdai): paleisk dedikuotą serverį su **Goldberg Steam Emulator** `steam_api.dll`. Goldberg žaidimo-serverio `BeginAuthSession` patvirtina bet kokį bilietą iškart, tad serveris pasiekia `OnGSClientApprove` offline ir pereina prie `CHALLENGE`. Tada boto `STEAMCLIENTBLOB` (bet koks netuščias, gerai suformuotas blob) praeina ir likusi handshake dalis vyksta.

1. Gauk patikimą Goldberg `steam_api.dll` (susikompiliuok iš šaltinio arba naudok kopiją, kuria pasitiki — negriebk atsitiktinio binarinio failo). AppID yra **1250**.
2. Serverio `System/` kataloge padaryk `steam_api.dll` atsarginę kopiją, įdėk Goldberg versiją, pridėk `steam_appid.txt`=`1250` (jau yra) ir Goldberg `steam_settings/`, jei reikia.
3. Perkrauk serverį (`node launch-server.js` — pagal numatytuosius nustatymus nukreipia į projekto viduje esančią `_kfds/System` junction). Stebėk `server.log`, kaip GS auth aktyvuojasi be tikro Steam prisijungimo.
4. Paleisk botą: `node phase2_client.js --server 127.0.0.1:7707 --name Bot --ver 3339 --minver 3339 --blob <hex> --blob-size <n>` Tikėkis `CHALLENGE` → `LOGIN` → `USES`/`HAVE` → `WELCOME` → `JOIN` → in-level.
5. Phase 3 (Ready) atveju užfiksuok PlayerController kanalą + `ServerRestartPlayer` indeksą su `phase1_relay.js` (praleisk tikrą klientą vieną kartą) ir perduok `--ready --pc-channel N --restart-index M`.

> Šio serverio variklio versija yra **3339** (ne 3369) — perduok `--ver 3339 --minver 3339`.

Protokolo faktai, kurie už to slypi (patikrinti prieš tikrą UT2004 v3369 variklio šaltinį):

- **Valdymo kanalas yra ASCII tekstas**, o ne binarinis enum: `HELLO REVISION=0 MINVER=3180 VER=3369` → `CHALLENGE … CHALLENGE=<int> …` → `LOGIN RESPONSE=<int> URL=<url>` → `USES …`/`HAVE …` → `WELCOME` → `JOIN`.
- **Login auth yra triviali sveikojo skaičiaus maiša** — jokio CD-key, jokio MD5, jokio Steam bilieto: `RESPONSE = (Challenge*237) ^ 0x93fe92Ce ^ (Challenge>>16) ^ (Challenge<<16)` (UT2004 `UGameEngine::ChallengeResponse`). Įgyvendinta `phase2_client.js`.
- Transportas yra **bit-stream**: paketas = `PacketId` po to bunch'ai; bunch antraštė = `bControl/bOpen/bClose/bReliable/ChIndex/ChSeq/ChType/NumBits` + naudingoji apkrova; užbaigiamasis stop bitas. Konstantos `MAX_PACKETID=16384`, `MAX_CHSEQUENCE=1024`, `MAX_CHANNELS=1023`, `CHTYPE_Control=1/Actor=2/File=3`.

## Paleisk testus

```bash
pnpm test          # bitstream + netconn + relay smoke + handshake e2e
```

## Gyvo patvirtinimo runbook (reikia tikro žaidimo — padaryk pats)

Šie žingsniai reikalauja veikiančio tikro žaidimo, tad paleisk juos pats, kad patvirtintum prieš tikrą variklį ir užfiksuotum Phase 3 indeksus.

**1. Paleisk lokalų serverį** (headless, be 3D):

```powershell
pwsh -File run-local-server.ps1            # KF-BioticsLab on udp/7707
```

(arba priglobk listen serverį iš žaidimo meniu: Host Game.)

**2a. Užfiksuok TIKRO kliento handshake** (ground truth + Phase 3 indeksai):

```bash
node phase1_relay.js --listen 7708 --server 127.0.0.1:7707
```

Tada tikrame Killing Floor konsolėje: `open 127.0.0.1:7708`, pasirink perk ir spausk **Ready**. Relay užrašo kiekvieną paketą (hexdump + disasembliavimas) į `captures/`. Ieškok:

- tikslių `HELLO`/`CHALLENGE`/`LOGIN`/`USES`/`WELCOME`/`JOIN` eilučių (patvirtink, kad mūsų kadravimas jas švariai dekoduoja — jei disasembliavimas švarus, mūsų kodekas atitinka tikrą variklį);
- po JOIN, **actor kanalo indeksą**, kurį serveris naudoja tavo PlayerController, ir
- **patikimą bunch, kurį tavo tikras klientas siunčia paspaudus Ready** — jo kanalo indeksas = `--pc-channel`, o pirmasis supakuotas int jo naudingojoje apkrovoje = `ServerRestartPlayer` NetFields funkcijos indeksas = `--restart-index`.

**2b. Išbandyk mūsų headless klientą** tiesiogiai prieš serverį:

```bash
node phase2_client.js --server 127.0.0.1:7707 --name Bot
# kai turėsi indeksus iš 2a:
node phase2_client.js --server 127.0.0.1:7707 --name Bot --ready \
     --pc-channel <N> --restart-index <M>
```

Jei serveris atsako `FAILURE …`, žinutėje pasakyta kodėl (slaptažodis, versija, GUID). Pakoreguok `--ver/--minver`, `--url` ir t. t. ir bandyk iš naujo; klientas viską užrašo į `captures/`.

## Kliento parinktys

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

## Kas dar liko iki visiškai aklo Phase 3

Ready RPC siuntimui reikia dviejų prisijungimo/build specifinių skaičių (PC actor kanalo ir `ServerRestartPlayer` NetFields indekso) plius, `SelectVeterancy` atveju, perk klasės PackageMap objekto-nuorodos kodavimo. Šie yra deterministiniai, bet neatspėjami be vieno tikro capture (2a žingsnis). Pats siuntimo kelias yra įgyvendintas ir įrodytas e2e testu; užfiksuotų indeksų prijungimas uždaro ratą. Sunkiausias likęs paviršius yra _įeinančios_ actor/property replikacijos parsinimas (reikalingas tik jei botas turi reaguoti į žaidimo būseną — nereikalingas vien prisijungimui + Ready).

## Atsakomybės atsisakymas

Tai asmeninis reverse-engineering ir protokolų sąveikos projektas, publikuotas tyrimų ir švietimo tikslais. Naudok jį tik prieš serverius, kuriuos valdai arba kuriuos testuoti esi aiškiai įgaliotas. Neoficialaus kliento paleidimas, variklio reversavimas ar Steam auth bilietų generavimas gali pažeisti žaidimo EULA ir Steam Subscriber Agreement — tik tu pats atsakai už tai, kaip naudoji šį kodą. Jis pateikiamas **tokia, kokia yra** (as is) forma, be jokių garantijų (žr. licenciją). Nesusijęs su Tripwire Interactive ar Valve.

## Licencija

Copyright (c) 2026 TheBestPlan.

Išleista pagal **GNU General Public License v3.0 or later** (GPL-3.0-or-later). Visą tekstą rasi [LICENSE](../../LICENSE). Ši programa yra laisva programinė įranga: gali ją platinti ir/arba modifikuoti pagal tas sąlygas, ir ji pateikiama **be jokios garantijos**.
