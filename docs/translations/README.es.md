# Killing Floor Bot Client

[English](../../README.md) · [Русский](./README.ru.md) · **Español** · [Português](./README.pt.md) · [Lietuvių](./README.lt.md) · [Polski](./README.pl.md) · [Français](./README.fr.md) · [中文](./README.zh.md) · [日本語](./README.ja.md)

Cliente externo **estilo L2Walker**, sin interfaz gráfica, para Killing Floor (UE2.5). Habla el protocolo de red nativo de Unreal Engine 2 sobre UDP: sin lanzar el cliente del juego, sin inyección. Se conecta como un cliente real, supera la autenticación de Steam y entra en la partida.

> La documentación completa está en [`docs/`](../): [USAGE](../USAGE.md) · [PROTOCOL](../PROTOCOL.md) · [GOTCHAS](../GOTCHAS.md) · [SERVER-SETUP](../SERVER-SETUP.md). Se compila y ejecuta sobre Node.js (≥ 18); el gestor de paquetes es **pnpm**. `pnpm test` ejecuta la batería de pruebas.

## Bootstrap desde un clon limpio (Windows)

Git guarda **solo el código fuente**. Todo lo descargado —`node_modules`, node de 32 bits, binarios de koffi, Goldberg, Ghidra+JDK— queda bajo `.gitignore` y se restaura con un solo comando:

```bash
node bootstrap.js          # core (pnpm) + --real-steam (32-bit node + koffi-ia32)
node bootstrap.js --all    # + Goldberg (own server) + Ghidra/JDK (reverse-engineering)
```

Idempotente (se omite todo lo ya instalado). Necesita internet y 7-Zip. Después, `pnpm test`. Qué se descarga y por qué se detalla en [docs/USAGE.md](../USAGE.md).

## GUI (estilo clásico L2Walker)

Un envoltorio de escritorio en Electron alrededor del bot: una ventana con una barra Start/Stop/Ready/Leave, estado de la conexión, pestañas de configuración y un log. El lanzamiento y una **guía paso a paso (si hace falta Steam, el orden de trabajo, la salvedad del spawn)** están en [GUI.md](GUI.md):

```bash
pnpm install && pnpm start
```

## Qué funciona hoy

| Capa                                                   | Archivo                    | Estado                                                                                |
| ------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------- |
| Bit-stream (FBitReader/Writer, FString, FCompactIndex) | `lib/bitstream.js`         | hecho — 56/56 pruebas de ida y vuelta                                                  |
| Empaquetado de packet/bunch + canal de control         | `lib/netconn.js`           | hecho — 19/19 pruebas de autoconsistencia                                             |
| **Fase 1** — relay UDP MITM + desensamblador           | `phase1_relay.js`          | hecho — reenvía en ambos sentidos + desensambla (prueba de humo)                      |
| **Fase 2** — cliente de handshake                      | `phase2_client.js`         | hecho — máquina de estados completa contra mock (10/10 e2e); transporte validado en vivo contra servidor real |
| **Fase 3** — `ServerRestartPlayer` (Ready)             | `phase2_client.js --ready` | parcial — RPC emitido correctamente (e2e); falta captura para el índice de canal/campo |
| Barrera de Steam-auth (build 1065)                     | —                          | bloqueado — el servidor exige Steam GS auth; necesita **Goldberg en el servidor** (ver abajo) |

### Validación en vivo contra un servidor dedicado real (KF 1065 / engine 3339)

- **Transporte confirmado contra el engine real:** el `HELLO` del cliente fue aceptado y nuestro decodificador parseó limpiamente el texto de control del servidor real. Toda la pila bit-stream/packet/bunch/FString coincide con UE2.5 real.
- **Descubierto el handshake de Steam de KF** (revertido desde el `Engine.dll` del servidor + tráfico en vivo): `HELLO … STEAMID=%I64u` → servidor `STEAMENCRYPTIONKEY %s` → cliente `STEAMCLIENTBLOB SIZE/CHUNK/BLOB` (ticket de autenticación de Steam) → servidor `SendUserConnectAndAuthenticate` → asíncrono `OnGSClientApprove/Deny` → solo entonces `CHALLENGE`.
- **Steam auth es obligatorio.** Con el Steam del servidor sin conexión (`SteamAPI_Init failed`, nunca `Connected to Steam Servers`) el handshake **se atasca en `STEAMCLIENTBLOB`**: ni `CHALLENGE`, ni expulsión. No hay flag `-nosteam`/insecure, y un SteamID que coincide en una autoconexión no lo evita. Todo lo anterior a la barrera (transporte, HELLO, parseo de control) y lo posterior (`CHALLENGE→LOGIN→USES/HAVE→WELCOME→JOIN→ServerRestartPlayer`) está implementado; **solo queda cruzar la Steam auth.**

## Cruzar la barrera de Steam-auth — Goldberg en el servidor (runbook)

La vía limpia (legítima para un servidor propio): ejecutar el servidor dedicado con el `steam_api.dll` del **Goldberg Steam Emulator**. El `BeginAuthSession` de game-server de Goldberg aprueba cualquier ticket de inmediato, así que el servidor alcanza `OnGSClientApprove` sin conexión y avanza a `CHALLENGE`. Entonces el `STEAMCLIENTBLOB` del bot (cualquier blob no vacío y bien formado) pasa y el resto del handshake se ejecuta.

1. Consigue un `steam_api.dll` de Goldberg de confianza (compílalo desde el código fuente, o usa una copia en la que confíes; no cojas un binario cualquiera). El AppID es **1250**.
2. En el `System/` del servidor, respalda `steam_api.dll`, coloca el de Goldberg, añade `steam_appid.txt`=`1250` (ya presente), y el `steam_settings/` de Goldberg si hace falta.
3. Reinicia el servidor (`node launch-server.js` — por defecto usa la junction `_kfds/System` interna del proyecto). Vigila `server.log` para ver la GS auth activándose sin una conexión real a Steam.
4. Ejecuta el bot: `node phase2_client.js --server 127.0.0.1:7707 --name Bot --ver 3339 --minver 3339 --blob <hex> --blob-size <n>` Espera `CHALLENGE` → `LOGIN` → `USES`/`HAVE` → `WELCOME` → `JOIN` → en el nivel.
5. Para la Fase 3 (Ready), captura el canal del PlayerController + el índice de `ServerRestartPlayer` con `phase1_relay.js` (enruta el cliente real una vez) y pasa `--ready --pc-channel N --restart-index M`.

> La versión de engine de este servidor es **3339** (no 3369) — pasa `--ver 3339 --minver 3339`.

Los hechos del protocolo tras esto (verificados contra el código fuente del engine real UT2004 v3369):

- **El canal de control es texto ASCII**, no un enum binario: `HELLO REVISION=0 MINVER=3180 VER=3369` → `CHALLENGE … CHALLENGE=<int> …` → `LOGIN RESPONSE=<int> URL=<url>` → `USES …`/`HAVE …` → `WELCOME` → `JOIN`.
- **La auth de login es un cifrado entero trivial** — sin CD-key, sin MD5, sin ticket de Steam: `RESPONSE = (Challenge*237) ^ 0x93fe92Ce ^ (Challenge>>16) ^ (Challenge<<16)` (UT2004 `UGameEngine::ChallengeResponse`). Implementado en `phase2_client.js`.
- El transporte es un **bit-stream**: packet = `PacketId` seguido de bunches; cabecera de bunch = `bControl/bOpen/bClose/bReliable/ChIndex/ChSeq/ChType/NumBits` + payload; bit de parada final. Constantes `MAX_PACKETID=16384`, `MAX_CHSEQUENCE=1024`, `MAX_CHANNELS=1023`, `CHTYPE_Control=1/Actor=2/File=3`.

## Ejecutar las pruebas

```bash
pnpm test          # bitstream + netconn + relay smoke + handshake e2e
```

## Runbook de validación en vivo (necesita el juego real — hazlo tú mismo)

Estos pasos necesitan el juego real en ejecución, así que hazlos tú mismo para validar contra el engine real y capturar los índices de la Fase 3.

**1. Arranca un servidor local** (headless, sin 3D):

```powershell
pwsh -File run-local-server.ps1            # KF-BioticsLab on udp/7707
```

(o levanta un listen server desde el menú del juego: Host Game.)

**2a. Captura el handshake de un cliente REAL** (verdad de referencia + índices de la Fase 3):

```bash
node phase1_relay.js --listen 7708 --server 127.0.0.1:7707
```

Luego en la consola real de Killing Floor: `open 127.0.0.1:7708`, elige un perk, pulsa **Ready**. El relay registra cada packet (hexdump + desensamblado) en `captures/`. Busca:

- las líneas exactas `HELLO`/`CHALLENGE`/`LOGIN`/`USES`/`WELCOME`/`JOIN` (confirma que nuestro framing las decodifica limpiamente — si el desensamblado es limpio, nuestro códec coincide con el engine real);
- tras JOIN, el **índice del canal de actor** que el servidor usa para tu PlayerController, y
- el **bunch fiable que tu cliente real envía al pulsar Ready** — su índice de canal = `--pc-channel`, y el primer entero empaquetado en su payload = el índice de función NetFields de `ServerRestartPlayer` = `--restart-index`.

**2b. Prueba nuestro cliente headless** directamente contra el servidor:

```bash
node phase2_client.js --server 127.0.0.1:7707 --name Bot
# once you have the indices from 2a:
node phase2_client.js --server 127.0.0.1:7707 --name Bot --ready \
     --pc-channel <N> --restart-index <M>
```

Si el servidor responde `FAILURE …`, el mensaje dice por qué (contraseña, versión, GUID). Ajusta `--ver/--minver`, `--url`, etc. y reintenta; el cliente registra todo en `captures/`.

## Opciones del cliente

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

## Qué falta para una Fase 3 totalmente a ciegas

Enviar el RPC de Ready requiere dos números específicos de la conexión/build (el canal de actor del PC y el índice NetFields de `ServerRestartPlayer`) más, para `SelectVeterancy`, una codificación de object-ref del PackageMap de la clase de perk. Son deterministas pero no adivinables sin una captura real (paso 2a). La ruta de envío en sí está implementada y demostrada por la prueba e2e; cablear los índices capturados cierra el bucle. La superficie más difícil que queda es _parsear la replicación entrante_ de actor/property (solo necesaria si el bot debe reaccionar al estado del juego — no hace falta para meramente conectar + Ready).

## Aviso legal

Este es un proyecto personal de ingeniería inversa e interoperabilidad de protocolos, publicado con fines de investigación y educativos. Úsalo solo contra servidores que poseas o para los que tengas autorización explícita de pruebas. Ejecutar un cliente no oficial, aplicar ingeniería inversa al engine o generar tickets de autenticación de Steam puede violar el EULA del juego y el Steam Subscriber Agreement — tú eres el único responsable del uso que hagas de este código. Se proporciona **tal cual**, sin garantía alguna (ver la licencia). No afiliado a Tripwire Interactive ni a Valve.

## Licencia

Copyright (c) 2026 TheBestPlan.

Publicado bajo la **GNU General Public License v3.0 or later** (GPL-3.0-or-later). Consulta [LICENSE](../../LICENSE) para el texto completo. Este programa es software libre: puedes redistribuirlo y/o modificarlo bajo esos términos, y se entrega **sin garantía**.
