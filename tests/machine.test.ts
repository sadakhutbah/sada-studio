import { describe, expect, it } from "vitest";
import { INITIAL_STATE, SessionMachine, canStart, isActive, transition, type SessionEvent, type SessionState } from "../src/core/session/machine";

const opts = { maxAttempts: 3 };
const run = (events: SessionEvent[], from: SessionState = INITIAL_STATE) => events.reduce((s, e) => transition(s, e, opts), from);

describe("machine d'état de la session", () => {
  it("parcourt le cycle nominal idle → connexion → direct → arrêt → idle", () => {
    expect(run([{ type: "START" }]).status).toBe("connecting");
    const live = run([{ type: "START" }, { type: "CONNECTED", at: 1000 }]);
    expect(live).toMatchObject({ status: "live", startedAt: 1000, attempt: 0 });
    expect(run([{ type: "STOP" }], live).status).toBe("stopping");
    expect(run([{ type: "STOP" }, { type: "STOPPED" }], live)).toEqual(INITIAL_STATE);
  });

  it("passe en reconnexion à la perte de liaison et garde l'heure de début", () => {
    const s = run([{ type: "START" }, { type: "CONNECTED", at: 5 }, { type: "CONNECTION_LOST", reason: "coupure" }]);
    expect(s).toMatchObject({ status: "reconnecting", attempt: 1, startedAt: 5, error: "coupure" });
    const back = run([{ type: "CONNECTED", at: 99 }], s);
    expect(back).toMatchObject({ status: "live", startedAt: 5, attempt: 0, error: null });
  });

  it("compte les échecs de reconnexion puis passe en erreur au-delà du maximum", () => {
    let s = run([{ type: "START" }, { type: "CONNECTED", at: 0 }, { type: "CONNECTION_LOST", reason: "x" }]);
    s = run([{ type: "RETRY_FAILED", reason: "a" }], s);
    expect(s).toMatchObject({ status: "reconnecting", attempt: 2 });
    s = run([{ type: "RETRY_FAILED", reason: "b" }], s);
    expect(s).toMatchObject({ status: "reconnecting", attempt: 3 });
    s = run([{ type: "RETRY_FAILED", reason: "dernière" }], s);
    expect(s).toMatchObject({ status: "error", error: "dernière" });
  });

  it("échec initial : erreur, puis nouvel essai ou remise à zéro", () => {
    const err = run([{ type: "START" }, { type: "FATAL", reason: "refusé" }]);
    expect(err).toMatchObject({ status: "error", error: "refusé" });
    expect(run([{ type: "START" }], err).status).toBe("connecting");
    expect(run([{ type: "RESET" }], err)).toEqual(INITIAL_STATE);
  });

  it("peut s'arrêter pendant la connexion et pendant la reconnexion", () => {
    expect(run([{ type: "START" }, { type: "STOP" }]).status).toBe("stopping");
    const rec = run([{ type: "START" }, { type: "CONNECTED", at: 0 }, { type: "CONNECTION_LOST", reason: "x" }, { type: "STOP" }]);
    expect(rec.status).toBe("stopping");
  });

  it("ignore les évènements impossibles en rendant le même objet", () => {
    for (const e of [{ type: "CONNECTED", at: 1 }, { type: "STOP" }, { type: "CONNECTION_LOST", reason: "x" }] as SessionEvent[]) {
      expect(transition(INITIAL_STATE, e, opts)).toBe(INITIAL_STATE);
    }
    const stopping = run([{ type: "START" }, { type: "STOP" }]);
    expect(transition(stopping, { type: "START" }, opts)).toBe(stopping);
  });

  it("canStart / isActive", () => {
    expect(canStart(INITIAL_STATE)).toBe(true);
    expect(isActive(run([{ type: "START" }]))).toBe(true);
    expect(canStart(run([{ type: "START" }]))).toBe(false);
  });

  it("SessionMachine notifie seulement les vrais changements", () => {
    const m = new SessionMachine(opts);
    const seen: string[] = [];
    m.subscribe((s) => seen.push(s.status));
    m.send({ type: "STOP" });
    m.send({ type: "START" });
    m.send({ type: "START" });
    expect(seen).toEqual(["connecting"]);
  });
});
