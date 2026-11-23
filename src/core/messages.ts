/**
 * User-facing messages produced by the core and main processes (errors, health checks, dialogs).
 * Each message has a French and an English text; French is the default, like the renderer UI
 * (`src/renderer/src/strings.ts`). Placeholders use `{name}`.
 */
export type Locale = "fr" | "en";

const fr = {
  // API client
  "api.addressMissing": "Adresse de l'instance manquante.",
  "api.addressInvalid": "Adresse de l'instance invalide.",
  "api.addressScheme": "L'adresse doit commencer par https:// (http n'est admis qu'en local).",
  "api.liveActiveSince": "Un direct est déjà en cours depuis {time}.",
  "api.liveActive": "Un direct est déjà en cours.",
  "api.pairingIncomplete": "Réponse d'appairage incomplète.",
  "api.mosqueDefault": "Mosquée",
  "api.httpError": "Erreur {status}",
  "api.whipUnexpected": "Réponse WHIP inattendue ({status}).",
  "api.whipForeign": "Ressource WHIP hors de l'instance.",
  "api.notPaired": "Appareil non appairé.",
  "api.unreachable": "Serveur Sada injoignable.",
  // Errors
  "error.deviceRemoved": "Cet appareil a été retiré de la console Sada.",
  // Capture
  "media.denied": "Accès à la caméra ou au micro refusé par le système.",
  "media.notFound": "Caméra ou micro introuvable.",
  "media.inUse": "Caméra ou micro déjà utilisé par une autre application.",
  "media.failed": "Capture impossible.",
  // Transport and session
  "whip.emptyOffer": "Offre SDP vide.",
  "whip.timeout": "Liaison WebRTC non établie à temps.",
  "whip.refused": "Liaison WebRTC refusée.",
  "whip.notAuthorized": "Cet appareil n'est plus autorisé à diffuser.",
  "session.deviceLost": "La caméra ou le micro a été déconnecté.",
  // Supervisor
  "sup.alreadyPaired": "Cet appareil est déjà appairé.",
  "sup.titleRequired": "Saisissez un titre pour le direct.",
  "sup.serverReachable": "Serveur Sada joignable.",
  "sup.pairDenied": "La demande a été refusée dans la console Sada. Relancez l'appairage pour obtenir un nouveau code.",
  "sup.notPaired": "Cet appareil n'est pas appairé.",
  "sup.relayLost": "La liaison avec le relais est coupée : reconnexion en cours.",
  "sup.heartbeatsMissed": "Le serveur Sada n'a pas répondu à {n} battements de suite.",
  "sup.noLongerAuthorized": "{message} Cet appareil n'est plus autorisé : appairez-le de nouveau depuis la console Sada, rubrique Appareils.",
  "ipc.invalidLive": "Type ou titre invalide.",
  // Update gate
  "update.liveRunning": "Un direct est en cours : la mise à jour attend la fin.",
  "update.slotRunning": "Un créneau est en cours : la mise à jour attend la fin.",
  "update.liveNear": "Un direct est proche : la mise à jour attend la fin du créneau.",
  // Formatting
  "when.today": "aujourd'hui à {clock}",
  "when.tomorrow": "demain à {clock}",
  "when.day": "{day} à {clock}",
  // Quit dialog
  "quit.title": "Quitter {app}",
  "quit.live": "Un direct est en cours. Quitter l'arrêtera.",
  "quit.idle": "Quitter Sada Studio ?",
  "quit.detail": "Une fois fermée, l'application ne diffusera plus les directs planifiés, jusqu'au prochain démarrage de Windows ou de l'application.",
  "quit.stay": "Rester",
  "tray.open": "Ouvrir Sada Studio",
  "quit.quit": "Quitter",
  // Health checks
  "health.na": "Sans objet sur ce système.",
  "health.unreadable": "Réglage illisible.",
  "health.camera.title": "Caméra",
  "health.camera.unknown": "Pas encore vérifiée.",
  "health.camera.one": "Une caméra détectée.",
  "health.camera.many": "{n} caméras détectées.",
  "health.camera.none": "Aucune caméra détectée.",
  "health.camera.fix": "Vérifiez que la caméra est branchée (essayez un autre port USB) et qu'elle n'est pas utilisée par une autre application. L'application la recherche toute seule et reprend dès qu'elle revient.",
  "health.micro.title": "Micro",
  "health.micro.unknown": "Pas encore vérifié.",
  "health.micro.one": "Un micro détecté.",
  "health.micro.many": "{n} micros détectés.",
  "health.micro.none": "Aucun micro détecté.",
  "health.micro.fix": "Vérifiez le branchement du micro ou de la table de mixage. Dans Windows : Paramètres, Confidentialité, Microphone, autorisez les applications de bureau.",
  "health.vault.title": "Appairage mémorisé",
  "health.vault.ok": "L'identité de l'appareil est chiffrée par le système et survit au redémarrage.",
  "health.vault.none": "Aucun coffre sécurisé : l'appairage sera perdu à la fermeture de l'application.",
  "health.vault.fix": "Sous Windows, le coffre est fourni par la session utilisateur : utilisez un compte Windows normal (pas un compte invité).",
  "health.launch.title": "Démarrage avec Windows",
  "health.launch.ok": "Sada Studio se lance à l'ouverture de la session.",
  "health.launch.no": "Sada Studio n'est pas inscrit au démarrage de la session.",
  "health.launch.fix": "Ouvrez Paramètres, Applications, Démarrage, et activez Sada Studio. Sinon, réinstallez l'application avec l'installeur.",
  "health.autologon.title": "Ouverture de session automatique",
  "health.autologon.ok": "Windows ouvre la session seul après un redémarrage.",
  "health.autologon.no": "Windows attend un mot de passe après un redémarrage : sans personne, l'application ne se lance pas.",
  "health.autologon.fix": "Touche Windows + R, tapez « netplwiz », décochez « Les utilisateurs doivent entrer un nom et un mot de passe », puis validez avec le mot de passe du compte. Si la case n'existe pas : Paramètres, Comptes, Options de connexion, désactivez « Pour une sécurité accrue… Windows Hello ».",
  "health.hours.title": "Mises à jour de Windows",
  "health.hours.unset": "Heures d'activité non définies : Windows peut redémarrer à tout moment, y compris pendant un créneau.",
  "health.hours.fixUnset": "Paramètres, Windows Update, Options avancées, Heures d'activité : choisissez une plage qui couvre vos directs.",
  "health.hours.range": "{start} à {end}",
  "health.hours.hour": "{n} h",
  "health.hours.covered": "Les heures d'activité ({range}) couvrent les directs planifiés.",
  "health.hours.noSlots": "Heures d'activité : {range}. Aucun direct planifié à comparer.",
  "health.hours.uncoveredOne": "Heures d'activité {range} : un direct planifié sort de cette plage (par exemple {slot}). Windows pourrait redémarrer pendant ce direct.",
  "health.hours.uncoveredMany": "Heures d'activité {range} : {n} directs planifiés sortent de cette plage (par exemple {slot}). Windows pourrait redémarrer pendant ce direct.",
  "health.hours.fixWiden": "Paramètres, Windows Update, Options avancées, Heures d'activité : élargissez la plage (18 heures au plus) pour qu'elle contienne tous les créneaux.",
  "health.sleep.title": "Mise en veille",
  "health.sleep.never": "L'ordinateur ne se met jamais en veille sur secteur.",
  "health.sleep.after": "L'ordinateur se met en veille après {n} minutes d'inactivité : il manquerait les directs.",
  "health.sleep.fix": "Paramètres, Système, Alimentation : réglez « Mettre en veille » sur « Jamais » pour le mode branché sur secteur.",
  // IP camera + local audio capture
  "capture.running": "Caméra IP et micro local : flux en cours.",
  "capture.notRunning": "Caméra IP et micro local : capture arrêtée.",
  "capture.outage": "Caméra IP ou micro local sans signal depuis un moment : {reason}",
  "capture.restored": "Caméra IP et micro local : le flux est rétabli.",
  "capture.exited": "ffmpeg s'est arrêté (code {code}).",
  "capture.stalled": "Flux figé : plus de progression.",
  "capture.calib.noAudio": "Aucun son enregistré pendant la calibration.",
  "capture.calib.noVideo": "Aucune image reçue pendant la calibration.",
  "capture.calib.noClap": "Claquement non détecté : tapez franchement dans les mains face à la caméra, près du micro.",
  "capture.calib.audioBehind": "Le son arrive après l'image : un retard audio ne peut pas le corriger.",
  "capture.calib.ffmpeg": "La calibration a échoué : {detail}",
  "capture.invalidConfig": "Adresse RTSP ou périphérique audio invalide.",
} as const;

export type MessageKey = keyof typeof fr;

const en: Record<MessageKey, string> = {
  "api.addressMissing": "Instance address is missing.",
  "api.addressInvalid": "Instance address is invalid.",
  "api.addressScheme": "The address must start with https:// (http is only allowed locally).",
  "api.liveActiveSince": "A live is already running since {time}.",
  "api.liveActive": "A live is already running.",
  "api.pairingIncomplete": "Incomplete pairing response.",
  "api.mosqueDefault": "Mosque",
  "api.httpError": "Error {status}",
  "api.whipUnexpected": "Unexpected WHIP response ({status}).",
  "api.whipForeign": "WHIP resource outside the instance.",
  "api.notPaired": "Device not paired.",
  "api.unreachable": "Sada server unreachable.",
  "error.deviceRemoved": "This device was removed from the Sada console.",
  "media.denied": "Access to the camera or microphone was denied by the system.",
  "media.notFound": "Camera or microphone not found.",
  "media.inUse": "Camera or microphone already in use by another application.",
  "media.failed": "Capture failed.",
  "whip.emptyOffer": "Empty SDP offer.",
  "whip.timeout": "WebRTC link not established in time.",
  "whip.refused": "WebRTC link refused.",
  "whip.notAuthorized": "This device is no longer allowed to broadcast.",
  "session.deviceLost": "The camera or microphone was disconnected.",
  "sup.alreadyPaired": "This device is already paired.",
  "sup.titleRequired": "Enter a title for the live.",
  "sup.serverReachable": "Sada server reachable.",
  "sup.pairDenied": "The request was denied in the Sada console. Restart pairing to get a new code.",
  "sup.notPaired": "This device is not paired.",
  "sup.relayLost": "The link with the relay is down: reconnecting.",
  "sup.heartbeatsMissed": "The Sada server did not answer {n} heartbeats in a row.",
  "sup.noLongerAuthorized": "{message} This device is no longer authorized: pair it again from the Sada console, under Devices.",
  "ipc.invalidLive": "Invalid type or title.",
  "update.liveRunning": "A live is running: the update waits for it to end.",
  "update.slotRunning": "A slot is running: the update waits for it to end.",
  "update.liveNear": "A live is about to start: the update waits for the end of the slot.",
  "when.today": "today at {clock}",
  "when.tomorrow": "tomorrow at {clock}",
  "when.day": "{day} at {clock}",
  "quit.title": "Quit {app}",
  "quit.live": "A live is running. Quitting will stop it.",
  "quit.idle": "Quit Sada Studio?",
  "quit.detail": "Once closed, the application will no longer broadcast scheduled lives until Windows or the application starts again.",
  "quit.stay": "Stay",
  "tray.open": "Open Sada Studio",
  "quit.quit": "Quit",
  "health.na": "Not applicable on this system.",
  "health.unreadable": "Setting unreadable.",
  "health.camera.title": "Camera",
  "health.camera.unknown": "Not checked yet.",
  "health.camera.one": "One camera detected.",
  "health.camera.many": "{n} cameras detected.",
  "health.camera.none": "No camera detected.",
  "health.camera.fix": "Check that the camera is plugged in (try another USB port) and not used by another application. The application keeps looking for it and resumes as soon as it is back.",
  "health.micro.title": "Microphone",
  "health.micro.unknown": "Not checked yet.",
  "health.micro.one": "One microphone detected.",
  "health.micro.many": "{n} microphones detected.",
  "health.micro.none": "No microphone detected.",
  "health.micro.fix": "Check the microphone or mixing desk connection. In Windows: Settings, Privacy, Microphone, allow desktop apps.",
  "health.vault.title": "Pairing remembered",
  "health.vault.ok": "The device identity is encrypted by the system and survives a restart.",
  "health.vault.none": "No secure vault: the pairing will be lost when the application closes.",
  "health.vault.fix": "On Windows, the vault is provided by the user session: use a regular Windows account (not a guest account).",
  "health.launch.title": "Start with Windows",
  "health.launch.ok": "Sada Studio starts when the session opens.",
  "health.launch.no": "Sada Studio is not registered to start with the session.",
  "health.launch.fix": "Open Settings, Apps, Startup, and enable Sada Studio. Otherwise, reinstall the application with the installer.",
  "health.autologon.title": "Automatic sign-in",
  "health.autologon.ok": "Windows signs in by itself after a restart.",
  "health.autologon.no": "Windows waits for a password after a restart: with nobody there, the application does not start.",
  "health.autologon.fix": "Press Windows + R, type \"netplwiz\", untick \"Users must enter a user name and password\", then confirm with the account password. If the box is missing: Settings, Accounts, Sign-in options, turn off \"For improved security… Windows Hello\".",
  "health.hours.title": "Windows Update",
  "health.hours.unset": "Active hours not set: Windows may restart at any time, including during a slot.",
  "health.hours.fixUnset": "Settings, Windows Update, Advanced options, Active hours: choose a range that covers your lives.",
  "health.hours.range": "{start} to {end}",
  "health.hours.hour": "{n}:00",
  "health.hours.covered": "The active hours ({range}) cover the scheduled lives.",
  "health.hours.noSlots": "Active hours: {range}. No scheduled live to compare.",
  "health.hours.uncoveredOne": "Active hours {range}: one scheduled live falls outside this range (for example {slot}). Windows could restart during this live.",
  "health.hours.uncoveredMany": "Active hours {range}: {n} scheduled lives fall outside this range (for example {slot}). Windows could restart during this live.",
  "health.hours.fixWiden": "Settings, Windows Update, Advanced options, Active hours: widen the range (18 hours at most) so that it contains every slot.",
  "health.sleep.title": "Sleep",
  "health.sleep.never": "The computer never sleeps on mains power.",
  "health.sleep.after": "The computer goes to sleep after {n} minutes of inactivity: it would miss lives.",
  "health.sleep.fix": "Settings, System, Power: set \"Sleep\" to \"Never\" for plugged-in mode.",
  // IP camera + local audio capture
  "capture.running": "IP camera and local microphone: stream running.",
  "capture.notRunning": "IP camera and local microphone: capture stopped.",
  "capture.outage": "IP camera or local microphone has had no signal for a while: {reason}",
  "capture.restored": "IP camera and local microphone: the stream is back.",
  "capture.exited": "ffmpeg exited (code {code}).",
  "capture.stalled": "Stream frozen: no progress.",
  "capture.calib.noAudio": "No sound was recorded during calibration.",
  "capture.calib.noVideo": "No picture was received during calibration.",
  "capture.calib.noClap": "Clap not detected: clap your hands sharply in front of the camera, near the microphone.",
  "capture.calib.audioBehind": "The sound arrives after the picture: an audio delay cannot fix that.",
  "capture.calib.ffmpeg": "Calibration failed: {detail}",
  "capture.invalidConfig": "Invalid RTSP address or audio device.",
};

const catalogs: Record<Locale, Record<MessageKey, string>> = { fr, en };

let current: Locale = "fr";

export function setLocale(locale: Locale): void {
  current = locale;
}

export function getLocale(): Locale {
  return current;
}

/** BCP 47 tag matching the current locale, for `Intl` formatters. */
export function intlLocale(): string {
  return current === "fr" ? "fr-FR" : "en-GB";
}

/** Looks a message up in the current locale and fills its `{placeholders}`. */
export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
  return catalogs[current][key].replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
}
