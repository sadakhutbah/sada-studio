// Faux serveur Sada pour essayer l'interface sans instance : `npm run mock`, puis
// adresse http://127.0.0.1:8787, identifiant libre, mot de passe « secret ».
// Le point WHIP répond 409 : il n'existe aucun relais derrière.
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 8787);
const user = { id: 1, name: "Imam Démo", role: "admin", role_label: "Administrateur", permissions: ["live"] };
const mosque = { id: 1, slug: "demo", name: "Mosquée de démonstration", access: "member" };

createServer((req, res) => {
  const send = (status, data, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(data));
  };
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/api/v1/login-challenge") return send(200, { pre: "demo" }, { "set-cookie": "sada_pre=demo; Path=/" });
    if (req.url === "/api/v1/login") {
      if (new URLSearchParams(body).get("password") !== "secret") return send(401, { error: "identifiants" });
      return send(200, { user, mosque, mosques: [mosque], csrf: "demo" }, { "set-cookie": "sada_session=demo; Path=/" });
    }
    if (req.url === "/api/v1/mosques/select") return send(200, { user, mosque, mosques: [mosque], csrf: "demo" });
    if (req.url?.startsWith("/api/v1/live/studio/whip")) return send(409, { error: "input is not push" });
    send(404, { error: "not found" });
  });
}).listen(port, "127.0.0.1", () => console.log(`Faux Sada sur http://127.0.0.1:${port}`));
