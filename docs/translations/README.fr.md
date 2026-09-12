# Killing Floor Bot Client

[English](../../README.md) · [Русский](./README.ru.md) · [Español](./README.es.md) · [Português](./README.pt.md) · [Lietuvių](./README.lt.md) · [Polski](./README.pl.md) · **Français** · [中文](./README.zh.md) · [日本語](./README.ja.md)

Client headless externe, **façon L2Walker**, pour Killing Floor (UE2.5). Parle nativement le protocole réseau d'Unreal Engine 2 en UDP — aucun lancement du client de jeu, aucune injection. Se connecte comme un vrai client, passe l'auth Steam et entre en jeu.

> La documentation complète se trouve dans [`docs/`](../) : [USAGE](../USAGE.md) · [PROTOCOL](../PROTOCOL.md) · [GOTCHAS](../GOTCHAS.md) · [SERVER-SETUP](../SERVER-SETUP.md). Build et exécution sur Node.js (≥ 18) ; le gestionnaire de paquets est **pnpm**. `pnpm test` lance la suite de tests.

## Bootstrap depuis un clone propre (Windows)

Git ne garde que les **sources**. Tout ce qui est téléchargé — `node_modules`, node 32 bits, binaires koffi, Goldberg, Ghidra+JDK — est sous `.gitignore` et restauré en une seule commande :

```bash
node bootstrap.js          # core (pnpm) + --real-steam (32-bit node + koffi-ia32)
node bootstrap.js --all    # + Goldberg (own server) + Ghidra/JDK (reverse-engineering)
```

Idempotent (tout ce qui est déjà installé est ignoré). Nécessite internet et 7-Zip. Ensuite `pnpm test`. Ce qui est téléchargé et pourquoi est décrit dans [docs/USAGE.md](../USAGE.md).

## GUI (style L2Walker classique)

Un wrapper de bureau Electron autour du bot — une fenêtre avec une barre d'outils Start/Stop/Ready/Leave, l'état de la connexion, des onglets de config et un journal. Le lancement et un **guide pas à pas (si Steam est nécessaire, l'ordre de travail, la subtilité du spawn)** sont dans [GUI.md](GUI.md) :

```bash
pnpm install && pnpm start
```

## Ce qui fonctionne aujourd'hui

| Couche                                                 | Fichier                    | État                                                                                   |
| ------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------- |
| Flux de bits (FBitReader/Writer, FString, FCompactIndex) | `lib/bitstream.js`         | terminé — 56/56 tests aller-retour                                                     |
| Découpage paquet/bunch + canal de contrôle             | `lib/netconn.js`           | terminé — 19/19 tests de cohérence interne                                             |
| **Phase 1** — relais MITM UDP + désassembleur          | `phase1_relay.js`          | terminé — relaie dans les deux sens + désassemble (smoke test)                          |
| **Phase 2** — client de handshake                      | `phase2_client.js`         | terminé — machine à états complète contre mock (10/10 e2e) ; transport validé en live contre un vrai serveur |
| **Phase 3** — `ServerRestartPlayer` (Ready)            | `phase2_client.js --ready` | partiel — RPC émis correctement (e2e) ; capture requise pour l'index de canal/champ     |
| Verrou d'auth Steam (build 1065)                       | —                          | bloqué — le serveur impose l'auth Steam GS ; nécessite **Goldberg sur le serveur** (voir ci-dessous) |

### Validation en live contre un vrai serveur dédié (KF 1065 / engine 3339)

- **Transport confirmé contre le vrai moteur :** le `HELLO` du client a été accepté et notre décodeur a analysé proprement le texte de contrôle du vrai serveur. Toute la pile flux de bits/paquet/bunch/FString correspond au vrai UE2.5.
- **Découverte du handshake Steam de KF** (rétro-conçu depuis l'`Engine.dll` du serveur + le trafic en live) : `HELLO … STEAMID=%I64u` → serveur `STEAMENCRYPTIONKEY %s` → client `STEAMCLIENTBLOB SIZE/CHUNK/BLOB` (ticket d'auth Steam) → serveur `SendUserConnectAndAuthenticate` → async `OnGSClientApprove/Deny` → et seulement ensuite `CHALLENGE`.
- **L'auth Steam est imposée.** Avec le Steam du serveur hors ligne (`SteamAPI_Init failed`, jamais `Connected to Steam Servers`), le handshake **cale à `STEAMCLIENTBLOB`** — pas de `CHALLENGE`, pas de kick. Il n'y a aucun flag `-nosteam`/insecure, et une correspondance de SteamID en auto-connexion ne le contourne pas. Tout ce qui précède le verrou (transport, HELLO, parse du contrôle) et tout ce qui le suit (`CHALLENGE→LOGIN→USES/HAVE→WELCOME→JOIN→ServerRestartPlayer`) est implémenté ; **il ne reste qu'à franchir l'auth Steam.**

## Franchir le verrou d'auth Steam — Goldberg sur le serveur (runbook)

La méthode propre (légitime pour un serveur que vous possédez) : lancer le serveur dédié avec le `steam_api.dll` de l'**émulateur Steam Goldberg**. Le `BeginAuthSession` côté game-server de Goldberg approuve n'importe quel ticket immédiatement, donc le serveur atteint `OnGSClientApprove` hors ligne et poursuit vers `CHALLENGE`. Ensuite le `STEAMCLIENTBLOB` du bot (n'importe quel blob non vide et bien formé) passe et le reste du handshake se déroule.

1. Procurez-vous un `steam_api.dll` Goldberg de confiance (compilez-le depuis les sources, ou utilisez une copie en laquelle vous avez confiance — ne récupérez pas un binaire au hasard). L'AppID est **1250**.
2. Dans le `System/` du serveur, sauvegardez `steam_api.dll`, mettez celui de Goldberg à la place, ajoutez `steam_appid.txt`=`1250` (déjà présent), et le `steam_settings/` de Goldberg si nécessaire.
3. Redémarrez le serveur (`node launch-server.js` — par défaut la jonction `_kfds/System` interne au projet). Surveillez `server.log` pour voir l'auth GS s'activer sans vraie connexion Steam.
4. Lancez le bot : `node phase2_client.js --server 127.0.0.1:7707 --name Bot --ver 3339 --minver 3339 --blob <hex> --blob-size <n>` Attendez-vous à `CHALLENGE` → `LOGIN` → `USES`/`HAVE` → `WELCOME` → `JOIN` → en jeu.
5. Pour la Phase 3 (Ready), capturez le canal du PlayerController + l'index de `ServerRestartPlayer` avec `phase1_relay.js` (routez le vrai client une fois) et passez `--ready --pc-channel N --restart-index M`.

> La version du moteur pour ce serveur est **3339** (pas 3369) — passez `--ver 3339 --minver 3339`.

Les faits de protocole derrière tout ça (vérifiés contre les sources du vrai moteur UT2004 v3369) :

- **Le canal de contrôle est du texte ASCII**, pas un enum binaire : `HELLO REVISION=0 MINVER=3180 VER=3369` → `CHALLENGE … CHALLENGE=<int> …` → `LOGIN RESPONSE=<int> URL=<url>` → `USES …`/`HAVE …` → `WELCOME` → `JOIN`.
- **L'auth de login est un simple brouillage d'entier** — pas de CD-key, pas de MD5, pas de ticket Steam : `RESPONSE = (Challenge*237) ^ 0x93fe92Ce ^ (Challenge>>16) ^ (Challenge<<16)` (UT2004 `UGameEngine::ChallengeResponse`). Implémenté dans `phase2_client.js`.
- Le transport est un **flux de bits** : paquet = `PacketId` puis des bunches ; en-tête de bunch = `bControl/bOpen/bClose/bReliable/ChIndex/ChSeq/ChType/NumBits` + charge utile ; bit d'arrêt final. Constantes `MAX_PACKETID=16384`, `MAX_CHSEQUENCE=1024`, `MAX_CHANNELS=1023`, `CHTYPE_Control=1/Actor=2/File=3`.

## Lancer les tests

```bash
pnpm test          # bitstream + netconn + relay smoke + handshake e2e
```

## Runbook de validation en live (nécessite le vrai jeu — à faire vous-même)

Ces étapes nécessitent le vrai jeu en cours d'exécution, donc lancez-les vous-même pour valider contre le vrai moteur et capturer les index de la Phase 3.

**1. Démarrer un serveur local** (headless, sans 3D) :

```powershell
pwsh -File run-local-server.ps1            # KF-BioticsLab on udp/7707
```

(ou hébergez un listen server depuis le menu du jeu : Host Game.)

**2a. Capturer le handshake d'un VRAI client** (vérité terrain + index de la Phase 3) :

```bash
node phase1_relay.js --listen 7708 --server 127.0.0.1:7707
```

Puis dans la console du vrai Killing Floor : `open 127.0.0.1:7708`, choisissez un perk, appuyez sur **Ready**. Le relais journalise chaque paquet (hexdump + désassemblage) dans `captures/`. Cherchez :

- les lignes exactes `HELLO`/`CHALLENGE`/`LOGIN`/`USES`/`WELCOME`/`JOIN` (confirmez que notre framing les décode proprement — si le désassemblage est propre, notre codec correspond au vrai moteur) ;
- après JOIN, l'**index de canal d'acteur** que le serveur utilise pour votre PlayerController, et
- le **bunch fiable que votre vrai client envoie quand vous appuyez sur Ready** — son index de canal = `--pc-channel`, et le premier packed int de sa charge utile = l'index de fonction NetFields de `ServerRestartPlayer` = `--restart-index`.

**2b. Essayer notre client headless** directement contre le serveur :

```bash
node phase2_client.js --server 127.0.0.1:7707 --name Bot
# once you have the indices from 2a:
node phase2_client.js --server 127.0.0.1:7707 --name Bot --ready \
     --pc-channel <N> --restart-index <M>
```

Si le serveur répond `FAILURE …`, le message dit pourquoi (mot de passe, version, GUID). Ajustez `--ver/--minver`, `--url`, etc. et réessayez ; le client journalise tout dans `captures/`.

## Options du client

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

## Ce qu'il reste pour une Phase 3 entièrement à l'aveugle

L'envoi du RPC Ready requiert deux nombres spécifiques à la connexion/au build (le canal d'acteur du PC et l'index NetFields de `ServerRestartPlayer`) plus, pour `SelectVeterancy`, un encodage de référence d'objet PackageMap de la classe de perk. Ils sont déterministes mais impossibles à deviner sans une vraie capture (étape 2a). Le chemin d'envoi lui-même est implémenté et prouvé par le test e2e ; câbler les index capturés boucle la boucle. La surface la plus ardue qui reste est l'_analyse en entrée_ de la réplication d'acteurs/propriétés (nécessaire seulement si le bot doit réagir à l'état du jeu — pas nécessaire juste pour se connecter + Ready).

## Avertissement

Ceci est un projet personnel de rétro-ingénierie et d'interopérabilité de protocole, publié à des fins de recherche et d'éducation. Utilisez-le uniquement contre des serveurs que vous possédez ou que vous êtes explicitement autorisé à tester. Exécuter un client non officiel, rétro-concevoir le moteur ou générer des tickets d'auth Steam peut enfreindre l'EULA du jeu et le Steam Subscriber Agreement — vous êtes seul responsable de l'usage que vous faites de ce code. Il est fourni **en l'état**, sans aucune garantie (voir la licence). Non affilié à Tripwire Interactive ni à Valve.

## Licence

Copyright (c) 2026 TheBestPlan.

Distribué sous la **GNU General Public License v3.0 or later** (GPL-3.0-or-later). Voir [LICENSE](../../LICENSE) pour le texte complet. Ce programme est un logiciel libre : vous pouvez le redistribuer et/ou le modifier selon ces termes, et il est fourni **sans aucune garantie**.
