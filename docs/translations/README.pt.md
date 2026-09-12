# Killing Floor Bot Client

[English](../../README.md) · [Русский](./README.ru.md) · [Español](./README.es.md) · **Português** · [Lietuvių](./README.lt.md) · [Polski](./README.pl.md) · [Français](./README.fr.md) · [中文](./README.zh.md) · [日本語](./README.ja.md)

Cliente headless externo, **no estilo L2Walker**, para Killing Floor (UE2.5). Fala o protocolo de rede nativo do Unreal Engine 2 sobre UDP — sem iniciar o cliente do jogo, sem injeção. Conecta como um cliente real, passa pela autenticação Steam e entra no jogo.

> A documentação completa fica em [`docs/`](../): [USAGE](../USAGE.md) · [PROTOCOL](../PROTOCOL.md) · [GOTCHAS](../GOTCHAS.md) · [SERVER-SETUP](../SERVER-SETUP.md). Compilado e executado com Node.js (≥ 18); o gerenciador de pacotes é o **pnpm**. `pnpm test` roda a suíte.

## Bootstrap a partir de um clone limpo (Windows)

O Git guarda **apenas o código-fonte**. Tudo que é baixado — `node_modules`, node de 32 bits, binários koffi, Goldberg, Ghidra+JDK — está sob `.gitignore` e é restaurado com um único comando:

```bash
node bootstrap.js          # core (pnpm) + --real-steam (32-bit node + koffi-ia32)
node bootstrap.js --all    # + Goldberg (own server) + Ghidra/JDK (reverse-engineering)
```

Idempotente (o que já está instalado é ignorado). Precisa de internet e do 7-Zip. Depois `pnpm test`. O que é baixado e por quê está descrito em [docs/USAGE.md](../USAGE.md).

## GUI (estilo L2Walker clássico)

Um wrapper desktop em Electron em torno do bot — uma janela com barra de ferramentas Start/Stop/Ready/Leave, status de conexão, abas de configuração e um log. O modo de iniciar e um **guia passo a passo (se o Steam é necessário, a ordem de operação, a ressalva sobre o spawn)** estão em [GUI.md](GUI.md):

```bash
pnpm install && pnpm start
```

## O que funciona hoje

| Camada                                                 | Arquivo                    | Status                                                                                |
| ------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------- |
| Bit-stream (FBitReader/Writer, FString, FCompactIndex) | `lib/bitstream.js`         | pronto — 56/56 testes de round-trip                                                   |
| Framing de pacote/bunch + canal de controle            | `lib/netconn.js`           | pronto — 19/19 testes de autoconsistência                                             |
| **Fase 1** — relay UDP MITM + disassembler             | `phase1_relay.js`          | pronto — encaminha nos dois sentidos + desmonta (smoke test)                          |
| **Fase 2** — cliente de handshake                      | `phase2_client.js`         | pronto — máquina de estados completa vs mock (10/10 e2e); transporte validado ao vivo vs servidor real |
| **Fase 3** — `ServerRestartPlayer` (Ready)             | `phase2_client.js --ready` | parcial — RPC emitido corretamente (e2e); precisa de captura para o índice de canal/campo |
| Barreira de autenticação Steam (build 1065)            | —                          | bloqueado — o servidor impõe auth GS Steam; precisa de **Goldberg no servidor** (ver abaixo) |

### Validação ao vivo contra um servidor dedicado real (KF 1065 / engine 3339)

- **Transporte confirmado contra o engine real:** o `HELLO` do cliente foi aceito e nosso decodificador analisou de forma limpa o texto de controle do servidor real. Toda a pilha bit-stream/pacote/bunch/FString bate com o UE2.5 real.
- **Descobrimos o handshake Steam do KF** (revertido a partir do `Engine.dll` do servidor + tráfego ao vivo): `HELLO … STEAMID=%I64u` → `STEAMENCRYPTIONKEY %s` do servidor → `STEAMCLIENTBLOB SIZE/CHUNK/BLOB` do cliente (ticket de auth Steam) → `SendUserConnectAndAuthenticate` do servidor → `OnGSClientApprove/Deny` assíncrono → só então `CHALLENGE`.
- **A auth Steam é obrigatória.** Com o Steam do servidor offline (`SteamAPI_Init failed`, nunca `Connected to Steam Servers`) o handshake **trava em `STEAMCLIENTBLOB`** — sem `CHALLENGE`, sem kick. Não há flag `-nosteam`/insecure, e uma correspondência de SteamID por autoconexão não contorna isso. Tudo antes da barreira (transporte, HELLO, parse de controle) e depois dela (`CHALLENGE→LOGIN→USES/HAVE→WELCOME→JOIN→ServerRestartPlayer`) está implementado; **falta apenas atravessar a auth Steam.**

## Atravessando a barreira de autenticação Steam — Goldberg no servidor (runbook)

O caminho limpo (legítimo para um servidor que é seu): rodar o servidor dedicado com a `steam_api.dll` do **Goldberg Steam Emulator**. O `BeginAuthSession` de game-server do Goldberg aprova qualquer ticket imediatamente, então o servidor chega ao `OnGSClientApprove` offline e segue para o `CHALLENGE`. Aí o `STEAMCLIENTBLOB` do bot (qualquer blob não vazio e bem formado) passa e o resto do handshake roda.

1. Obtenha uma `steam_api.dll` confiável do Goldberg (compile a partir do código-fonte, ou use uma cópia em que você confia — não pegue um binário aleatório). O AppID é **1250**.
2. No `System/` do servidor, faça backup da `steam_api.dll`, coloque a do Goldberg, adicione `steam_appid.txt`=`1250` (já presente) e, se necessário, o `steam_settings/` do Goldberg.
3. Reinicie o servidor (`node launch-server.js` — usa por padrão a junção in-project `_kfds/System`). Observe o `server.log` para ver a auth GS ativando sem uma conexão Steam real.
4. Rode o bot: `node phase2_client.js --server 127.0.0.1:7707 --name Bot --ver 3339 --minver 3339 --blob <hex> --blob-size <n>` Espere `CHALLENGE` → `LOGIN` → `USES`/`HAVE` → `WELCOME` → `JOIN` → in-level.
5. Para a Fase 3 (Ready), capture o canal do PlayerController + o índice de `ServerRestartPlayer` com `phase1_relay.js` (roteie o cliente real uma vez) e passe `--ready --pc-channel N --restart-index M`.

> A versão de engine deste servidor é **3339** (não 3369) — passe `--ver 3339 --minver 3339`.

Os fatos de protocolo por trás disso (verificados contra o código-fonte real do engine UT2004 v3369):

- **O canal de controle é texto ASCII**, não um enum binário: `HELLO REVISION=0 MINVER=3180 VER=3369` → `CHALLENGE … CHALLENGE=<int> …` → `LOGIN RESPONSE=<int> URL=<url>` → `USES …`/`HAVE …` → `WELCOME` → `JOIN`.
- **A auth de login é um embaralhamento inteiro trivial** — sem CD-key, sem MD5, sem ticket Steam: `RESPONSE = (Challenge*237) ^ 0x93fe92Ce ^ (Challenge>>16) ^ (Challenge<<16)` (UT2004 `UGameEngine::ChallengeResponse`). Implementado em `phase2_client.js`.
- O transporte é um **bit-stream**: pacote = `PacketId` seguido de bunches; cabeçalho do bunch = `bControl/bOpen/bClose/bReliable/ChIndex/ChSeq/ChType/NumBits` + payload; stop bit no final. Constantes `MAX_PACKETID=16384`, `MAX_CHSEQUENCE=1024`, `MAX_CHANNELS=1023`, `CHTYPE_Control=1/Actor=2/File=3`.

## Rodar os testes

```bash
pnpm test          # bitstream + netconn + relay smoke + handshake e2e
```

## Runbook de validação ao vivo (precisa do jogo real — faça você mesmo)

Estes passos precisam do jogo real rodando, então rode-os você mesmo para validar contra o engine real e capturar os índices da Fase 3.

**1. Inicie um servidor local** (headless, sem 3D):

```powershell
pwsh -File run-local-server.ps1            # KF-BioticsLab on udp/7707
```

(ou hospede um listen server pelo menu do jogo: Host Game.)

**2a. Capture o handshake de um cliente REAL** (ground truth + índices da Fase 3):

```bash
node phase1_relay.js --listen 7708 --server 127.0.0.1:7707
```

Depois, no console do Killing Floor real: `open 127.0.0.1:7708`, escolha um perk, aperte **Ready**. O relay registra cada pacote (hexdump + disassembly) em `captures/`. Procure por:

- as linhas exatas de `HELLO`/`CHALLENGE`/`LOGIN`/`USES`/`WELCOME`/`JOIN` (confirme que nosso framing as decodifica de forma limpa — se a disassembly está limpa, nosso codec bate com o engine real);
- depois do JOIN, o **índice do canal de actor** que o servidor usa para o seu PlayerController, e
- o **reliable bunch que o seu cliente real envia quando você aperta Ready** — seu índice de canal = `--pc-channel`, e o packed int inicial em seu payload = o índice da função `ServerRestartPlayer` em NetFields = `--restart-index`.

**2b. Experimente nosso cliente headless** diretamente contra o servidor:

```bash
node phase2_client.js --server 127.0.0.1:7707 --name Bot
# once you have the indices from 2a:
node phase2_client.js --server 127.0.0.1:7707 --name Bot --ready \
     --pc-channel <N> --restart-index <M>
```

Se o servidor responder `FAILURE …`, a mensagem diz o porquê (senha, versão, GUID). Ajuste `--ver/--minver`, `--url`, etc. e tente de novo; o cliente registra tudo em `captures/`.

## Opções do cliente

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

## O que falta para uma Fase 3 totalmente às cegas

Enviar o RPC de Ready exige dois números específicos da conexão/build (o canal de actor do PC e o índice de `ServerRestartPlayer` em NetFields) mais, para `SelectVeterancy`, uma codificação de object-ref via PackageMap da classe do perk. Esses números são determinísticos, mas não dá para adivinhá-los sem uma captura real (passo 2a). O caminho de envio em si está implementado e comprovado pelo teste e2e; conectar os índices capturados fecha o ciclo. A superfície mais difícil que resta é _parsear a replicação de actor/propriedade recebida_ (só necessária se o bot tiver de reagir ao estado do jogo — não é necessária apenas para conectar + Ready).

## Aviso legal

Este é um projeto pessoal de engenharia reversa e interoperabilidade de protocolo, publicado para fins de pesquisa e educação. Use-o apenas contra servidores que são seus ou que você está explicitamente autorizado a testar. Rodar um cliente não oficial, fazer engenharia reversa do engine ou gerar tickets de auth Steam pode violar o EULA do jogo e o Steam Subscriber Agreement — você é o único responsável pelo uso que faz deste código. Ele é fornecido **como está**, sem qualquer garantia (veja a licença). Sem afiliação com a Tripwire Interactive ou a Valve.

## Licença

Copyright (c) 2026 TheBestPlan.

Distribuído sob a **GNU General Public License v3.0 or later** (GPL-3.0-or-later). Veja [LICENSE](../../LICENSE) para o texto completo. Este programa é software livre: você pode redistribuí-lo e/ou modificá-lo sob esses termos, e ele vem **sem garantia**.
