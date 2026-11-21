import type { HealthCheck, Slot } from "../api/types";
import { slotEnd } from "../kiosk/schedule";

/** Ce que le processus principal a pu lire sur Windows ; `null` (plutôt qu'un objet) hors Windows. */
export interface WindowsFacts {
  /** Ouverture de session automatique (sans mot de passe). */
  autoLogon: boolean | null;
  activeHours: { start: number; end: number } | null;
  sleepAcSeconds: number | null;
  /** L'application est inscrite au démarrage de la session. */
  launchAtLogin: boolean | null;
}

export interface HealthInput {
  windows: WindowsFacts | null;
  /** Nombre de caméras et micros vus par le système ; `null` tant qu'inconnu. */
  cameras: number | null;
  microphones: number | null;
  schedule: Slot[];
  now: number;
  /** Le secret de l'appareil survit à un redémarrage. */
  vaultPersistent: boolean;
}

/** `na` : sans objet sur ce système (contrôle Windows ailleurs que sous Windows) ; jamais affiché. */
export type HealthStatus = "ok" | "warn" | "problem" | "unknown" | "na";

export interface HealthItem {
  id: string;
  title: string;
  status: HealthStatus;
  /** Ce qui a été constaté. */
  detail: string;
  /** Marche à suivre, en français, quand ce n'est pas bon. */
  fix?: string;
}

const HORIZON_MS = 14 * 24 * 3600_000;

/** Heures d'activité Windows : [start, end) en heures locales ; end < start = la plage passe minuit. */
export function hourInActiveHours(hourFloat: number, h: { start: number; end: number }): boolean {
  if (h.start === h.end) return true;
  return h.start < h.end ? hourFloat >= h.start && hourFloat < h.end : hourFloat >= h.start || hourFloat < h.end;
}

const localHour = (ms: number) => {
  const d = new Date(ms);
  return d.getHours() + d.getMinutes() / 60;
};

/** Créneaux des deux prochaines semaines que les heures d'activité ne couvrent pas en entier. */
export function uncoveredSlots(schedule: Slot[], h: { start: number; end: number }, now: number): Slot[] {
  return schedule.filter((s) => {
    if (s.startsAt > now + HORIZON_MS || slotEnd(s) <= now) return false;
    const endMs = slotEnd(s);
    // Une plage qui dépasse 18 h ou franchit la fin des heures d'activité n'est pas protégée.
    const spanOk = (endMs - s.startsAt) / 3600_000 <= 18;
    const sh = localHour(s.startsAt);
    const eh = localHour(endMs - 1);
    const sameDay = new Date(s.startsAt).toDateString() === new Date(endMs - 1).toDateString();
    const covered = hourInActiveHours(sh, h) && hourInActiveHours(eh, h) && (sameDay || h.start >= h.end);
    return !(spanOk && covered);
  });
}

const hh = (n: number) => `${n} h`;
const fmtSlot = (s: Slot) =>
  new Date(s.startsAt).toLocaleString("fr-FR", { weekday: "long", hour: "2-digit", minute: "2-digit" });

/** Tous les contrôles, en français. Hors Windows, les contrôles propres à Windows sont simplement omis. */
export function evaluateHealth(i: HealthInput): HealthItem[] {
  const out: HealthItem[] = [];

  out.push(
    i.cameras === null
      ? { id: "camera", title: "Caméra", status: "unknown", detail: "Pas encore vérifiée." }
      : i.cameras > 0
        ? { id: "camera", title: "Caméra", status: "ok", detail: i.cameras === 1 ? "Une caméra détectée." : `${i.cameras} caméras détectées.` }
        : {
            id: "camera",
            title: "Caméra",
            status: "problem",
            detail: "Aucune caméra détectée.",
            fix: "Vérifiez que la caméra est branchée (essayez un autre port USB) et qu'elle n'est pas utilisée par une autre application. L'application la recherche toute seule et reprend dès qu'elle revient.",
          },
  );
  out.push(
    i.microphones === null
      ? { id: "micro", title: "Micro", status: "unknown", detail: "Pas encore vérifié." }
      : i.microphones > 0
        ? { id: "micro", title: "Micro", status: "ok", detail: i.microphones === 1 ? "Un micro détecté." : `${i.microphones} micros détectés.` }
        : {
            id: "micro",
            title: "Micro",
            status: "problem",
            detail: "Aucun micro détecté.",
            fix: "Vérifiez le branchement du micro ou de la table de mixage. Dans Windows : Paramètres, Confidentialité, Microphone, autorisez les applications de bureau.",
          },
  );

  out.push(
    i.vaultPersistent
      ? { id: "device_vault", title: "Appairage mémorisé", status: "ok", detail: "L'identité de l'appareil est chiffrée par le système et survit au redémarrage." }
      : {
          id: "device_vault",
          title: "Appairage mémorisé",
          status: "warn",
          detail: "Aucun coffre sécurisé : l'appairage sera perdu à la fermeture de l'application.",
          fix: "Sous Windows, le coffre est fourni par la session utilisateur : utilisez un compte Windows normal (pas un compte invité).",
        },
  );

  const w = i.windows;
  if (!w) {
    for (const id of ["windows_autologon", "windows_update_active_hours", "sleep"]) {
      out.push({ id, title: id, status: "na", detail: "Sans objet sur ce système." });
    }
    return out;
  }

  if (w.launchAtLogin !== null) {
    out.push(
      w.launchAtLogin
        ? { id: "launch_at_login", title: "Démarrage avec Windows", status: "ok", detail: "Sada Studio se lance à l'ouverture de la session." }
        : {
            id: "launch_at_login",
            title: "Démarrage avec Windows",
            status: "warn",
            detail: "Sada Studio n'est pas inscrit au démarrage de la session.",
            fix: "Ouvrez Paramètres, Applications, Démarrage, et activez Sada Studio. Sinon, réinstallez l'application avec l'installeur.",
          },
    );
  }

  out.push(
    w.autoLogon === null
      ? { id: "windows_autologon", title: "Ouverture de session automatique", status: "unknown", detail: "Réglage illisible." }
      : w.autoLogon
        ? { id: "windows_autologon", title: "Ouverture de session automatique", status: "ok", detail: "Windows ouvre la session seul après un redémarrage." }
        : {
            id: "windows_autologon",
            title: "Ouverture de session automatique",
            status: "problem",
            detail: "Windows attend un mot de passe après un redémarrage : sans personne, l'application ne se lance pas.",
            fix: "Touche Windows + R, tapez « netplwiz », décochez « Les utilisateurs doivent entrer un nom et un mot de passe », puis validez avec le mot de passe du compte. Si la case n'existe pas : Paramètres, Comptes, Options de connexion, désactivez « Pour une sécurité accrue… Windows Hello ».",
          },
  );

  if (!w.activeHours) {
    out.push({
      id: "windows_update_active_hours",
      title: "Mises à jour de Windows",
      status: "unknown",
      detail: "Heures d'activité non définies : Windows peut redémarrer à tout moment, y compris pendant un créneau.",
      fix: "Paramètres, Windows Update, Options avancées, Heures d'activité : choisissez une plage qui couvre vos directs.",
    });
  } else {
    const bad = uncoveredSlots(i.schedule, w.activeHours, i.now);
    const range = `${hh(w.activeHours.start)} à ${hh(w.activeHours.end)}`;
    out.push(
      bad.length === 0
        ? { id: "windows_update_active_hours", title: "Mises à jour de Windows", status: "ok", detail: i.schedule.length ? `Les heures d'activité (${range}) couvrent les directs planifiés.` : `Heures d'activité : ${range}. Aucun direct planifié à comparer.` }
        : {
            id: "windows_update_active_hours",
            title: "Mises à jour de Windows",
            status: "problem",
            detail: `Heures d'activité ${range} : ${bad.length === 1 ? "un direct planifié sort" : `${bad.length} directs planifiés sortent`} de cette plage (par exemple ${fmtSlot(bad[0])}). Windows pourrait redémarrer pendant ce direct.`,
            fix: "Paramètres, Windows Update, Options avancées, Heures d'activité : élargissez la plage (18 heures au plus) pour qu'elle contienne tous les créneaux.",
          },
    );
  }

  if (w.sleepAcSeconds === null) {
    out.push({ id: "sleep", title: "Mise en veille", status: "unknown", detail: "Réglage illisible." });
  } else if (w.sleepAcSeconds === 0) {
    out.push({ id: "sleep", title: "Mise en veille", status: "ok", detail: "L'ordinateur ne se met jamais en veille sur secteur." });
  } else {
    out.push({
      id: "sleep",
      title: "Mise en veille",
      status: "problem",
      detail: `L'ordinateur se met en veille après ${Math.round(w.sleepAcSeconds / 60)} minutes d'inactivité : il manquerait les directs.`,
      fix: "Paramètres, Système, Alimentation : réglez « Mettre en veille » sur « Jamais » pour le mode branché sur secteur.",
    });
  }
  return out;
}

/**
 * Contrôles tels que le serveur les reçoit. Un réglage illisible ou sans objet n'est pas une panne (`ok: true`) :
 * le serveur n'écrit aux opérateurs que pour de vrais problèmes.
 */
export function toChecks(items: HealthItem[]): HealthCheck[] {
  return items.map((i) => ({ id: i.id, ok: i.status !== "problem" && i.status !== "warn", detail: i.detail }));
}
