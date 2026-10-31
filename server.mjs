// Web multiusuario: Login Kit de TikTok + subida de MP4 como borrador (Content Posting API, video.upload).
// Cada usuario conecta su propia cuenta; los tokens se guardan cifrados (AES-256-GCM) en SQLite.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import express from "express";

const HERE = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.join(HERE, ".env"));
} catch {
  /* sin .env: se usan las variables del entorno */
}

const env = (name) => String(process.env[name] || "").trim();
const PORT = Number(env("PORT")) || 4100;
const BASE_URL = env("BASE_URL").replace(/\/+$/, "");
const CLIENT_KEY = env("TIKTOK_CLIENT_KEY");
const CLIENT_SECRET = env("TIKTOK_CLIENT_SECRET");
const SESSION_SECRET = env("SESSION_SECRET");
const TOKEN_KEY = env("TOKEN_KEY");
const DATA_DIR = path.resolve(HERE, env("DATA_DIR") || "./data");

for (const [name, value] of Object.entries({
  BASE_URL,
  TIKTOK_CLIENT_KEY: CLIENT_KEY,
  TIKTOK_CLIENT_SECRET: CLIENT_SECRET,
  SESSION_SECRET,
  TOKEN_KEY,
})) {
  if (!value) {
    console.error(`Falta la variable ${name} (ver .env.example).`);
    process.exit(1);
  }
}

const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const SCOPES = "user.info.basic,video.upload";
const MAX_VIDEO_BYTES = 64 * 1024 * 1024; // un solo fragmento: TikTok admite hasta 64 MB así
const MAX_UPLOADS_PER_HOUR = 10;
const SESSION_DAYS = 30;
const SECURE = BASE_URL.startsWith("https://");

fs.mkdirSync(path.join(DATA_DIR, "tmp"), { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "publisher.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    open_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL DEFAULT '',
    avatar_url TEXT NOT NULL DEFAULT '',
    access_enc TEXT NOT NULL,
    refresh_enc TEXT NOT NULL,
    access_expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    open_id TEXT NOT NULL,
    publish_id TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

// ---------- cifrado de tokens y cookies firmadas ----------
const tokenKey = crypto.createHash("sha256").update(TOKEN_KEY).digest();

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", tokenKey, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

function decrypt(blob) {
  const raw = Buffer.from(blob, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", tokenKey, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

const sign = (value) =>
  crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");

function makeSession(openId) {
  const body = `${openId}.${Date.now() + SESSION_DAYS * 86400_000}`;
  return `${body}.${sign(body)}`;
}

function readSession(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [openId, expires, mac] = parts;
  const expected = sign(`${openId}.${expires}`);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(expires) < Date.now()) return null;
  return openId;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, maxAgeSeconds) {
  const flags = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  flags.push(`Max-Age=${maxAgeSeconds}`);
  if (SECURE) flags.push("Secure");
  const prev = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", [].concat(prev || [], flags.join("; ")));
}

// ---------- API de TikTok ----------
const TT = "https://open.tiktokapis.com";

async function tiktokToken(params) {
  const res = await fetch(`${TT}/v2/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_key: CLIENT_KEY, client_secret: CLIENT_SECRET, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `TikTok rechazó el token (${res.status})`);
  }
  return data;
}

function saveTokens(openId, tokens, profile) {
  const expiresAt = Date.now() + (Number(tokens.expires_in) || 86400) * 1000 - 60_000;
  const existing = db.prepare("SELECT open_id FROM users WHERE open_id = ?").get(openId);
  if (existing) {
    db.prepare(
      `UPDATE users SET access_enc = ?, refresh_enc = ?, access_expires_at = ?,
        display_name = COALESCE(?, display_name), avatar_url = COALESCE(?, avatar_url)
       WHERE open_id = ?`
    ).run(
      encrypt(tokens.access_token),
      encrypt(tokens.refresh_token),
      expiresAt,
      profile?.display_name ?? null,
      profile?.avatar_url ?? null,
      openId
    );
  } else {
    db.prepare(
      `INSERT INTO users (open_id, display_name, avatar_url, access_enc, refresh_enc, access_expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      openId,
      profile?.display_name || "",
      profile?.avatar_url || "",
      encrypt(tokens.access_token),
      encrypt(tokens.refresh_token),
      expiresAt,
      Date.now()
    );
  }
}

async function accessTokenFor(user) {
  if (user.access_expires_at > Date.now()) return decrypt(user.access_enc);
  const tokens = await tiktokToken({
    grant_type: "refresh_token",
    refresh_token: decrypt(user.refresh_enc),
  });
  saveTokens(user.open_id, tokens, null);
  return tokens.access_token;
}

// ---------- app ----------
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"
  );
  next();
});

app.use((req, _res, next) => {
  const openId = readSession(parseCookies(req.headers.cookie).sid);
  req.user = openId ? db.prepare("SELECT * FROM users WHERE open_id = ?").get(openId) : null;
  next();
});

const requireUser = (req, res, next) =>
  req.user ? next() : res.status(401).json({ ok: false, error: "Inicia sesión con TikTok." });

// Las peticiones que cambian algo exigen esta cabecera (un formulario de otro sitio no puede enviarla).
const requireAjax = (req, res, next) =>
  req.get("X-Requested-With") === "fetch"
    ? next()
    : res.status(400).json({ ok: false, error: "Petición no válida." });

app.get("/auth/login", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  setCookie(res, "oauth_state", state, 600);
  const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
  url.searchParams.set("client_key", CLIENT_KEY);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});

app.get("/auth/callback", async (req, res) => {
  try {
    if (req.query.error) return res.redirect("/?login=cancelado");
    const expected = parseCookies(req.headers.cookie).oauth_state;
    if (!expected || expected !== String(req.query.state || "")) {
      return res.status(400).send("Sesión de inicio no válida. Vuelve a intentarlo.");
    }
    const code = String(req.query.code || "");
    if (!code) return res.status(400).send("Falta el código de TikTok.");

    const tokens = await tiktokToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    });
    const infoRes = await fetch(`${TT}/v2/user/info/?fields=open_id,display_name,avatar_url`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const info = await infoRes.json().catch(() => ({}));
    const profile = info?.data?.user || {};
    const openId = String(tokens.open_id || profile.open_id || "");
    if (!openId) throw new Error("TikTok no devolvió la identidad del usuario.");

    saveTokens(openId, tokens, profile);
    setCookie(res, "oauth_state", "", 0);
    setCookie(res, "sid", makeSession(openId), SESSION_DAYS * 86400);
    res.redirect("/");
  } catch (err) {
    console.error("callback:", err.message);
    res.status(500).send("No se pudo completar el inicio de sesión con TikTok.");
  }
});

app.get("/api/me", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!req.user) return res.json({ ok: true, user: null });
  res.json({
    ok: true,
    user: { displayName: req.user.display_name, avatarUrl: req.user.avatar_url },
    maxMb: MAX_VIDEO_BYTES / 1024 / 1024,
  });
});

app.post("/auth/logout", requireAjax, (_req, res) => {
  setCookie(res, "sid", "", 0);
  res.json({ ok: true });
});

// Borra todo lo que guardamos del usuario y revoca el acceso en TikTok.
app.post("/api/disconnect", requireAjax, requireUser, async (req, res) => {
  try {
    const token = await accessTokenFor(req.user).catch(() => null);
    if (token) {
      await fetch(`${TT}/v2/oauth/revoke/`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_key: CLIENT_KEY, client_secret: CLIENT_SECRET, token }),
      }).catch(() => {});
    }
    db.prepare("DELETE FROM uploads WHERE open_id = ?").run(req.user.open_id);
    db.prepare("DELETE FROM users WHERE open_id = ?").run(req.user.open_id);
    setCookie(res, "sid", "", 0);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/upload", requireAjax, requireUser, async (req, res) => {
  const tmpFile = path.join(DATA_DIR, "tmp", `${crypto.randomUUID()}.mp4`);
  try {
    const recent = db
      .prepare("SELECT COUNT(*) AS n FROM uploads WHERE open_id = ? AND created_at > ?")
      .get(req.user.open_id, Date.now() - 3600_000).n;
    if (recent >= MAX_UPLOADS_PER_HOUR) {
      return res.status(429).json({ ok: false, error: "Límite de 10 subidas por hora. Inténtalo más tarde." });
    }

    const declared = Number(req.get("content-length") || 0);
    if (!declared || declared > MAX_VIDEO_BYTES) {
      return res
        .status(413)
        .json({ ok: false, error: `El video debe pesar como máximo ${MAX_VIDEO_BYTES / 1024 / 1024} MB.` });
    }

    // Guarda el cuerpo en disco con tope de tamaño real (no solo el declarado).
    let received = 0;
    const out = fs.createWriteStream(tmpFile);
    await new Promise((resolve, reject) => {
      req.on("data", (chunk) => {
        received += chunk.length;
        if (received > MAX_VIDEO_BYTES) {
          req.destroy(new Error("too-large"));
          return;
        }
        if (!out.write(chunk)) {
          req.pause();
          out.once("drain", () => req.resume());
        }
      });
      req.on("end", () => out.end(resolve));
      req.on("error", reject);
      out.on("error", reject);
    });

    const buffer = fs.readFileSync(tmpFile);
    // Un MP4/MOV válido lleva "ftyp" en los bytes 4-8.
    if (buffer.length < 1024 || buffer.subarray(4, 8).toString("latin1") !== "ftyp") {
      return res.status(400).json({ ok: false, error: "El archivo no es un video MP4 válido." });
    }

    const token = await accessTokenFor(req.user);
    const initRes = await fetch(`${TT}/v2/post/publish/inbox/video/init/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({
        source_info: {
          source: "FILE_UPLOAD",
          video_size: buffer.length,
          chunk_size: buffer.length,
          total_chunk_count: 1,
        },
      }),
    });
    const init = await initRes.json().catch(() => ({}));
    if (!initRes.ok || (init.error && init.error.code !== "ok")) {
      const code = String(init?.error?.code || "");
      const error = code.includes("spam_risk")
        ? "Tienes demasiados borradores sin abrir en TikTok. Ábrelos en la app (Bandeja de entrada) y vuelve a intentarlo."
        : `TikTok rechazó la subida: ${init?.error?.message || code || initRes.status}`;
      return res.status(502).json({ ok: false, error });
    }
    const { upload_url: uploadUrl, publish_id: publishId } = init.data || {};
    if (!uploadUrl || !publishId) {
      return res.status(502).json({ ok: false, error: "TikTok no devolvió la dirección de subida." });
    }

    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(buffer.length),
        "Content-Range": `bytes 0-${buffer.length - 1}/${buffer.length}`,
      },
      body: buffer,
    });
    if (!putRes.ok) {
      return res.status(502).json({ ok: false, error: `La subida a TikTok falló (${putRes.status}).` });
    }

    db.prepare("INSERT INTO uploads (open_id, publish_id, bytes, created_at) VALUES (?, ?, ?, ?)").run(
      req.user.open_id,
      publishId,
      buffer.length,
      Date.now()
    );
    res.json({ ok: true, publishId });
  } catch (err) {
    const tooLarge = err.message === "too-large";
    if (!res.headersSent) {
      res
        .status(tooLarge ? 413 : 500)
        .json({ ok: false, error: tooLarge ? "El video es demasiado grande." : "Error al subir el video." });
    }
    if (!tooLarge) console.error("upload:", err.message);
  } finally {
    fs.rm(tmpFile, { force: true }, () => {});
  }
});

app.get("/api/status/:publishId", requireUser, async (req, res) => {
  try {
    const owns = db
      .prepare("SELECT 1 FROM uploads WHERE open_id = ? AND publish_id = ?")
      .get(req.user.open_id, req.params.publishId);
    if (!owns) return res.status(404).json({ ok: false, error: "Subida no encontrada." });
    const token = await accessTokenFor(req.user);
    const r = await fetch(`${TT}/v2/post/publish/status/fetch/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ publish_id: req.params.publishId }),
    });
    const data = await r.json().catch(() => ({}));
    res.json({ ok: true, status: data?.data?.status || "UNKNOWN", failReason: data?.data?.fail_reason || "" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.use(express.static(path.join(HERE, "public"), { extensions: ["html"] }));

const HOST = env("HOST") || "127.0.0.1"; // en Docker se pone 0.0.0.0: el contenedor no publica puertos, solo Traefik llega a él
app.listen(PORT, HOST, () => {
  console.log(`tiktok-publisher escuchando en http://${HOST}:${PORT} (público: ${BASE_URL})`);
});
