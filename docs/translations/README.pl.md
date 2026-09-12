# Killing Floor Bot Client

[English](../../README.md) · [Русский](./README.ru.md) · [Español](./README.es.md) · [Português](./README.pt.md) · [Lietuvių](./README.lt.md) · **Polski** · [Français](./README.fr.md) · [中文](./README.zh.md) · [日本語](./README.ja.md)

Zewnętrzny, bezgłowy klient w **stylu L2Walker** dla Killing Floor (UE2.5). Mówi natywnym protokołem sieciowym Unreal Engine 2 po UDP — bez uruchamiania klienta gry, bez wstrzykiwania. Łączy się jako prawdziwy klient, przechodzi uwierzytelnianie Steam i wchodzi do gry.

> Pełna dokumentacja znajduje się w [`docs/`](../): [USAGE](../USAGE.md) · [PROTOCOL](../PROTOCOL.md) · [GOTCHAS](../GOTCHAS.md) · [SERVER-SETUP](../SERVER-SETUP.md). Budowany i uruchamiany na Node.js (≥ 18); menedżer pakietów to **pnpm**. `pnpm test` uruchamia zestaw testów.

## Bootstrap z czystego klona (Windows)

Git przechowuje **tylko źródła**. Wszystko pobierane — `node_modules`, 32-bitowy node, binaria koffi, Goldberg, Ghidra+JDK — jest w `.gitignore` i odtwarzane jednym poleceniem:

```bash
node bootstrap.js          # core (pnpm) + --real-steam (32-bit node + koffi-ia32)
node bootstrap.js --all    # + Goldberg (own server) + Ghidra/JDK (reverse-engineering)
```

Idempotentne (cokolwiek już zainstalowane jest pomijane). Wymaga internetu i 7-Zip. Potem `pnpm test`. Co jest pobierane i dlaczego opisano w [docs/USAGE.md](../USAGE.md).

## GUI (klasyczny styl L2Walker)

Desktopowa nakładka Electron wokół bota — okno z paskiem narzędzi Start/Stop/Ready/Leave, statusem połączenia, zakładkami konfiguracji i logiem. Uruchamianie oraz **przewodnik krok po kroku (czy Steam jest potrzebny, kolejność pracy, zastrzeżenie o spawnie)** są w [GUI.md](GUI.md):

```bash
pnpm install && pnpm start
```

## Co działa dzisiaj

| Warstwa                                                | Plik                       | Status                                                                                |
| ------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------- |
| Strumień bitów (FBitReader/Writer, FString, FCompactIndex) | `lib/bitstream.js`         | gotowe — 56/56 testów round-trip                                                       |
| Ramkowanie pakietów/bunchy + kanał kontrolny           | `lib/netconn.js`           | gotowe — 19/19 testów spójności wewnętrznej                                            |
| **Phase 1** — przekaźnik UDP MITM + deasembler         | `phase1_relay.js`          | gotowe — przekazuje w obie strony + deasembluje (smoke test)                           |
| **Phase 2** — klient handshake                         | `phase2_client.js`         | gotowe — pełna maszyna stanów vs mock (10/10 e2e); transport zweryfikowany na żywo vs prawdziwy serwer |
| **Phase 3** — `ServerRestartPlayer` (Ready)            | `phase2_client.js --ready` | częściowo — RPC emitowany poprawnie (e2e); potrzeba przechwycenia dla indeksu kanału/pola |
| Bramka uwierzytelniania Steam (build 1065)             | —                          | zablokowane — serwer wymusza Steam GS auth; potrzeba **Goldberg na serwerze** (patrz niżej) |

### Walidacja na żywo vs prawdziwy dedykowany serwer (KF 1065 / engine 3339)

- **Transport potwierdzony wobec prawdziwego silnika:** klienckie `HELLO` zostało zaakceptowane, a nasz dekoder czysto sparsował tekst kontrolny prawdziwego serwera. Cały stos strumienia bitów/pakietów/bunchy/FString zgadza się z prawdziwym UE2.5.
- **Odkryto handshake Steam w KF** (odtworzony z serwerowego `Engine.dll` + ruchu na żywo): `HELLO … STEAMID=%I64u` → serwer `STEAMENCRYPTIONKEY %s` → klient `STEAMCLIENTBLOB SIZE/CHUNK/BLOB` (bilet Steam auth) → serwer `SendUserConnectAndAuthenticate` → async `OnGSClientApprove/Deny` → dopiero potem `CHALLENGE`.
- **Uwierzytelnianie Steam jest wymuszane.** Przy wyłączonym Steamie na serwerze (`SteamAPI_Init failed`, nigdy `Connected to Steam Servers`) handshake **zatrzymuje się na `STEAMCLIENTBLOB`** — brak `CHALLENGE`, brak wyrzucenia. Nie ma flagi `-nosteam`/insecure, a zgodność SteamID przy self-connect tego nie obchodzi. Wszystko przed bramką (transport, HELLO, parsowanie kontroli) i po niej (`CHALLENGE→LOGIN→USES/HAVE→WELCOME→JOIN→ServerRestartPlayer`) jest zaimplementowane; **pozostaje jedynie przejście uwierzytelniania Steam.**

## Przekroczenie bramki Steam-auth — Goldberg na serwerze (runbook)

Czysta droga (legalna dla serwera, który posiadasz): uruchom dedykowany serwer z `steam_api.dll` z **Goldberg Steam Emulator**. Serwerowe `BeginAuthSession` w Goldbergu zatwierdza każdy bilet natychmiast, więc serwer osiąga `OnGSClientApprove` offline i przechodzi do `CHALLENGE`. Wtedy botowy `STEAMCLIENTBLOB` (dowolny niepusty, poprawnie sformowany blob) przechodzi i reszta handshake'u się wykonuje.

1. Zdobądź zaufany `steam_api.dll` Goldberga (zbuduj ze źródeł lub użyj kopii, której ufasz — nie chwytaj losowego binarium). AppID to **1250**.
2. W serwerowym `System/` zrób kopię zapasową `steam_api.dll`, podłóż wersję Goldberga, dodaj `steam_appid.txt`=`1250` (już obecny) oraz `steam_settings/` Goldberga, jeśli potrzeba.
3. Zrestartuj serwer (`node launch-server.js` — domyślnie junction `_kfds/System` w projekcie). Obserwuj `server.log`, czy GS auth aktywuje się bez prawdziwego połączenia ze Steamem.
4. Uruchom bota: `node phase2_client.js --server 127.0.0.1:7707 --name Bot --ver 3339 --minver 3339 --blob <hex> --blob-size <n>` Oczekuj `CHALLENGE` → `LOGIN` → `USES`/`HAVE` → `WELCOME` → `JOIN` → w poziomie.
5. Dla Phase 3 (Ready) przechwyć kanał PlayerController + indeks `ServerRestartPlayer` za pomocą `phase1_relay.js` (przepuść prawdziwego klienta raz) i przekaż `--ready --pc-channel N --restart-index M`.

> Wersja silnika dla tego serwera to **3339** (nie 3369) — przekaż `--ver 3339 --minver 3339`.

Fakty protokołu stojące za tym (zweryfikowane wobec źródeł prawdziwego silnika UT2004 v3369):

- **Kanał kontrolny to tekst ASCII**, nie binarny enum: `HELLO REVISION=0 MINVER=3180 VER=3369` → `CHALLENGE … CHALLENGE=<int> …` → `LOGIN RESPONSE=<int> URL=<url>` → `USES …`/`HAVE …` → `WELCOME` → `JOIN`.
- **Uwierzytelnianie logowania to trywialny scramble na liczbach całkowitych** — brak CD-key, brak MD5, brak biletu Steam: `RESPONSE = (Challenge*237) ^ 0x93fe92Ce ^ (Challenge>>16) ^ (Challenge<<16)` (UT2004 `UGameEngine::ChallengeResponse`). Zaimplementowane w `phase2_client.js`.
- Transport to **strumień bitów**: pakiet = `PacketId`, potem bunche; nagłówek bunchu = `bControl/bOpen/bClose/bReliable/ChIndex/ChSeq/ChType/NumBits` + payload; końcowy bit stop. Stałe `MAX_PACKETID=16384`, `MAX_CHSEQUENCE=1024`, `MAX_CHANNELS=1023`, `CHTYPE_Control=1/Actor=2/File=3`.

## Uruchom testy

```bash
pnpm test          # bitstream + netconn + relay smoke + handshake e2e
```

## Runbook walidacji na żywo (wymaga prawdziwej gry — zrób to samodzielnie)

Te kroki wymagają uruchomionej prawdziwej gry, więc wykonaj je samodzielnie, aby zweryfikować wobec prawdziwego silnika i przechwycić indeksy Phase 3.

**1. Uruchom lokalny serwer** (bezgłowy, bez 3D):

```powershell
pwsh -File run-local-server.ps1            # KF-BioticsLab on udp/7707
```

(albo hostuj listen server z menu gry: Host Game.)

**2a. Przechwyć handshake PRAWDZIWEGO klienta** (ground truth + indeksy Phase 3):

```bash
node phase1_relay.js --listen 7708 --server 127.0.0.1:7707
```

Następnie w konsoli prawdziwego Killing Floor: `open 127.0.0.1:7708`, wybierz perk, naciśnij **Ready**. Przekaźnik loguje każdy pakiet (hexdump + deasemblacja) do `captures/`. Szukaj:

- dokładnych linii `HELLO`/`CHALLENGE`/`LOGIN`/`USES`/`WELCOME`/`JOIN` (potwierdź, że nasze ramkowanie dekoduje je czysto — jeśli deasemblacja jest czysta, nasz kodek zgadza się z prawdziwym silnikiem);
- po JOIN **indeks kanału aktora**, którego serwer używa dla twojego PlayerController, oraz
- **niezawodny bunch, który twój prawdziwy klient wysyła po naciśnięciu Ready** — jego indeks kanału = `--pc-channel`, a wiodący spakowany int w jego payloadzie = indeks funkcji NetFields `ServerRestartPlayer` = `--restart-index`.

**2b. Wypróbuj naszego bezgłowego klienta** bezpośrednio wobec serwera:

```bash
node phase2_client.js --server 127.0.0.1:7707 --name Bot
# gdy masz już indeksy z 2a:
node phase2_client.js --server 127.0.0.1:7707 --name Bot --ready \
     --pc-channel <N> --restart-index <M>
```

Jeśli serwer odpowie `FAILURE …`, komunikat mówi dlaczego (hasło, wersja, GUID). Dostosuj `--ver/--minver`, `--url` itd. i spróbuj ponownie; klient loguje wszystko do `captures/`.

## Opcje klienta

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

## Co pozostaje do w pełni ślepego Phase 3

Wysłanie RPC Ready wymaga dwóch liczb specyficznych dla połączenia/buildu (kanał aktora PC oraz indeks NetFields `ServerRestartPlayer`) plus, dla `SelectVeterancy`, kodowania obiektowego odniesienia PackageMap dla klasy perka. Są one deterministyczne, ale niemożliwe do zgadnięcia bez jednego prawdziwego przechwycenia (krok 2a). Sama ścieżka wysyłania jest zaimplementowana i potwierdzona testem e2e; podpięcie przechwyconych indeksów zamyka pętlę. Najtrudniejsza pozostała powierzchnia to _parsowanie przychodzącej_ replikacji aktorów/właściwości (potrzebne tylko, jeśli bot musi reagować na stan gry — niepotrzebne do samego połączenia + Ready).

## Zastrzeżenie

To osobisty projekt inżynierii wstecznej i interoperacyjności protokołów, opublikowany w celach badawczych i edukacyjnych. Używaj go wyłącznie wobec serwerów, które posiadasz lub do testowania których masz wyraźną autoryzację. Uruchamianie nieoficjalnego klienta, inżynieria wsteczna silnika lub generowanie biletów Steam auth mogą naruszać EULA gry oraz Steam Subscriber Agreement — wyłącznie ty odpowiadasz za to, jak używasz tego kodu. Dostarczany jest **w stanie takim, jaki jest**, bez jakiejkolwiek gwarancji (patrz licencja). Niepowiązany z Tripwire Interactive ani Valve.

## Licencja

Copyright (c) 2026 TheBestPlan.

Wydany na licencji **GNU General Public License v3.0 or later** (GPL-3.0-or-later). Pełny tekst znajdziesz w [LICENSE](../../LICENSE). Ten program jest wolnym oprogramowaniem: możesz go rozpowszechniać i/lub modyfikować na tych warunkach, i jest dostarczany **bez żadnej gwarancji**.
