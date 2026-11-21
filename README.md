# Sada Studio

Application compagnon de [Sada](https://sadakhutbah.org) pour diffuser une khutba ou un dars depuis un ordinateur, sans OBS. Elle capture la caméra et le micro, puis envoie le direct à l'API Sada en WHIP ; Sada le relaie, l'enregistre et le transcrit.

Dépôt privé. Electron + Vite + React + TypeScript, comme le front de Sada (`sada/web`), avec sa charte graphique.

## Utilisation

1. Entrer l'adresse de l'instance et les identifiants du compte Sada (la connexion peut être mémorisée, chiffrée par le coffre du système).
2. Choisir la mosquée si le compte en a plusieurs, puis khutba ou dars et le titre.
3. Choisir caméra et micro, vérifier l'aperçu et le vu-mètre. Les traitements audio automatiques sont désactivés par défaut.
4. **Démarrer le direct**. En cas de coupure, la reconnexion est automatique.

Le compte doit avoir le droit `live` et l'entrée de la mosquée doit être en mode « push ».

## Développement

```
npm ci
npm run dev        # application en rechargement à chaud
npm run mock       # faux serveur Sada (http://127.0.0.1:8787, mot de passe « secret »)
npm run lint && npm run typecheck && npm test
npm run dist       # installeur du système courant, dans dist/
```

Sans caméra (WSL, CI) : `SADA_STUDIO_FAKE_MEDIA=1` simule caméra et micro ; sous Linux sans bac à sable, ajouter `--no-sandbox`.

## Architecture

```
src/core/       cœur indépendant d'Electron (réutilisable dans la console web)
  session/      machine d'état (idle, connexion, direct, reconnexion, erreur, arrêt) + BroadcastSession
  sources/      Strategy de source : caméra ; registre pour le partage d'écran
  transport/    Strategy de transport : WHIP ; SRT s'y ajoutera
  api/          interface StudioApi + client HTTP de la console Sada
  audio/        vu-mètre ; stats.ts : débit et durée
  extension-points.ts   mixage audio et scènes (types seulement, non implémentés)
src/main/       processus principal : fenêtre, IPC, coffre safeStorage, client API
src/preload/    pont `window.studio`
src/renderer/   interface React
tests/          machine d'état, session, client WHIP contre un serveur simulé
```

Le client Sada tourne dans le processus principal : cookies et mot de passe n'arrivent jamais à l'interface. La signalisation WHIP passe par `POST /api/v1/live/studio/whip` (session + `X-CSRF`) ; elle est isolée derrière `StudioApi`/`WhipSignaling` pour suivre la forme finale des points d'accès de la branche `feat/studio-whip-auth` de Sada.

## Intégration continue et installeurs

`.github/workflows/ci.yml` : lint, typecheck, tests et build à chaque push et pull request. Sur un tag `vX.Y.Z`, construction des installeurs Windows (NSIS) et macOS (dmg, zip) en artefacts du workflow.

## Signature

Les installeurs ne sont **pas signés** pour l'instant : Windows SmartScreen et macOS Gatekeeper afficheront un avertissement (macOS : clic droit puis Ouvrir). Pour signer : certificat Authenticode (`CSC_LINK`, `CSC_KEY_PASSWORD`) côté Windows ; Developer ID et notarisation Apple (`CSC_LINK`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) côté macOS, puis retirer `identity: null` dans `electron-builder.yml`.
