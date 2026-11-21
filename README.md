# Sada Studio

Application compagnon de [Sada](https://sadakhutbah.org) pour diffuser une khutba ou un dars depuis un ordinateur, sans OBS. Elle capture la caméra et le micro, puis envoie le direct à l'API Sada en WHIP ; Sada le relaie, l'enregistre et le transcrit.

Dépôt privé. Electron + Vite + React + TypeScript, comme le front de Sada (`sada/web`), avec sa charte graphique.

## Utilisation : le boîtier autonome

L'application tourne en permanence sur un PC de la mosquée, sans personne. Après un seul appairage, tout est automatique.

1. **Premier lancement** : saisir l'adresse de l'instance ; un grand code s'affiche. Dans la console Sada, Appareils, saisir ce code. Le code se renouvelle seul tant qu'il n'est pas saisi. Le secret de l'appareil est rangé chiffré (`safeStorage`, DPAPI sous Windows).
2. **Ensuite, rien à faire** : l'application démarre avec la session Windows, bat toutes les 30 s vers le serveur (10 s pendant un direct) et **n'envoie un flux que pendant un direct** : le serveur envoie `command: live` avec une marge avant le créneau, `idle` à la fin. Avant un créneau (10 min), l'état « armé » prépare la caméra sans rien émettre.
3. **Mode manuel** (hors planning) : choisir khutba ou dars, saisir un titre, « Lancer un direct » (`POST /studio/live/start`). « Arrêter le direct » demande confirmation puis appelle `POST /studio/live/stop`. Un créneau planifié ne coupe jamais un direct manuel ; un arrêt manuel pendant un créneau n'est pas relancé avant le créneau suivant (le serveur est maître).
4. **Désappairer** oublie l'identité sur le poste (le retrait côté console se fait dans Appareils). Si le serveur retire l'appareil (401), l'application revient à l'écran d'appairage avec une explication.
5. **Panneau « Santé du poste »** (lecture seule) : caméra, micro, ouverture de session Windows automatique, heures d'activité de Windows Update au regard du planning, mise en veille, démarrage avec Windows. Chaque problème donne la marche à suivre. Les contrôles Windows sont ignorés sur Mac et Linux.

Fermer la fenêtre réduit l'application dans la zone de notification ; « Quitter » (menu de l'icône) demande confirmation. Une seule instance tourne. Si le rendu plante ou se fige, la fenêtre est rechargée et l'état est repris : l'ordre vient de nouveau du serveur. Réseau ou caméra absents : nouvelles tentatives en boucle, attente croissante bornée (5 s à 60 s ; 1 à 5 min après un 409 « déjà en direct »).

## Contrat serveur (provisoire, branche `feat/studio-devices` de Sada)

Tout est isolé derrière `StudioApi` (`src/core/api/`), seul `SadaHttpApi` connaît les formes JSON.

| Appel | Corps / réponse |
| --- | --- |
| `POST /api/v1/studio/pair/start` | → `{device_code, user_code, expires_in, interval}` |
| `POST /api/v1/studio/pair/poll` `{device_code}` | → `{status:"pending"}` ou `{device_id, device_secret, mosque}` ; 404/410 = code expiré ; 403 = refusé |
| `POST /api/v1/studio/heartbeat` (Bearer appareil) | `{state, version, camera, micro, bitrate, health}` → `{config, schedule, command, current}` |
| `POST /api/v1/studio/live/start` `{type, title}` / `live/stop` | 409 : « Un direct est déjà en cours depuis X » (`since` ISO facultatif) |
| `POST /api/v1/live/studio/whip` (+ PATCH/DELETE) | signalisation WHIP avec le Bearer appareil ; 409 = un autre direct occupe la mosquée |

`health` : `{checks: [{id, ok, detail}], last_error: {code, message} | null, live_start_failure: {message} | null}`. Identifiants de contrôles stables : `camera`, `micro`, `network`, `windows_autologon`, `windows_update_active_hours`, `sleep`, `device_vault`, `launch_at_login` (les contrôles Windows sont `ok: true`, « sans objet », hors Windows ; un réglage illisible n'est pas une panne). Un battement immédiat part dès qu'un contrôle change d'état (écart minimal 2 s).
`current` : `{type, title, source: "manual"|"schedule", slot_id?}`. Créneau : `{id?, type, title, starts_at, ends_at?}` (ISO ou secondes).

## Développement

```
npm ci
npm run dev        # application en rechargement à chaud
npm run mock       # faux serveur Sada (http://127.0.0.1:8787) : code d'appairage accepté seul après 8 s, planning, direct manuel
npm run lint && npm run typecheck && npm test
npm run dist       # installeur du système courant, dans dist/
```

Essai de l'appairage en développement : `SADA_STUDIO_INSTANCE=http://127.0.0.1:8787 npm run dev` lance la demande de code au démarrage (ignoré par l'application installée).

Sans caméra (WSL, CI) : `SADA_STUDIO_FAKE_MEDIA=1` simule caméra et micro ; sous Linux sans bac à sable, ajouter `--no-sandbox`.

## Architecture

```
src/core/       cœur indépendant d'Electron (réutilisable dans la console web)
  session/      machine d'état de la liaison (idle, connexion, direct, reconnexion, erreur, arrêt) + BroadcastSession
  kiosk/        machine d'état du boîtier (unpaired, pairing, standby, armed, onair, revoked), KioskSupervisor
                (appairage, battement, direct manuel, reprise), LiveKeeper (session ↔ ordre, nouvelles tentatives),
                UpdateGate (mise à jour jamais pendant un direct), Backoff
  health/       contrôles « Santé du poste » et lecture de reg query / powercfg (fonctions pures)
  sources/      Strategy de source : caméra ; registre pour le partage d'écran
  transport/    Strategy de transport : WHIP ; SRT s'y ajoutera
  api/          interface StudioApi + client HTTP (Bearer appareil)
  audio/        vu-mètre ; stats.ts : débit et durée
src/main/       fenêtre, zone de notification, instance unique, veille, IPC, coffre safeStorage, mise à jour, lectures Windows
src/preload/    pont `window.studio`
src/renderer/   interface React (écran d'appairage, console du boîtier)
scripts/        mock-sada.mjs : faux serveur, partagé avec les tests
tests/          machines, superviseur (horloge simulée), gardien, mise à jour, santé, API et WHIP contre le faux serveur
```

Le client Sada et le secret de l'appareil vivent dans le processus principal ; l'interface ne reçoit que `KioskSnapshot`. Le serveur est maître : l'interface n'émet que lorsque `wantLive` est vrai.

## Mise à jour automatique

`electron-updater` lit les releases GitHub de `sadakhutbah/sada-studio` (`publish` dans `electron-builder.yml`, aucune release n'est créée par le code). Le téléchargement est libre, l'**installation** attend : jamais pendant un direct, un ordre live ou un créneau en cours, ni dans les 30 min avant un créneau (`UpdateGate`). Inactive hors application installée.

Pour publier : monter `version` dans `package.json`, `GH_TOKEN` (droit `contents:write`) dans l'environnement, puis `npx electron-builder --win --publish always` (ou un workflow sur tag, aujourd'hui `--publish never`). La release doit contenir `latest.yml`, l'installeur `.exe` et son `.blockmap`, générés par electron-builder.
**Dépôt privé** : le client ne peut pas lire des releases privées sans jeton. Choix à faire : héberger les mises à jour dans un dépôt public dédié (`publish.repo`), ou un serveur statique (`provider: generic`). Ne jamais embarquer de jeton dans l'application.

## Intégration continue et installeurs

`.github/workflows/ci.yml` : lint, typecheck, tests et build à chaque push et pull request. Sur un tag `vX.Y.Z`, construction des installeurs Windows (NSIS) et macOS (dmg, zip) en artefacts du workflow.

## Signature

Les installeurs ne sont **pas signés** pour l'instant : Windows SmartScreen et macOS Gatekeeper afficheront un avertissement (macOS : clic droit puis Ouvrir). Pour signer : certificat Authenticode (`CSC_LINK`, `CSC_KEY_PASSWORD`) côté Windows ; Developer ID et notarisation Apple (`CSC_LINK`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) côté macOS, puis retirer `identity: null` dans `electron-builder.yml`.
