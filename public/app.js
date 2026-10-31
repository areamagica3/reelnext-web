const $ = (id) => document.getElementById(id);
const post = (url, init = {}) =>
  fetch(url, { method: "POST", headers: { "X-Requested-With": "fetch" }, ...init });

let maxBytes = 64 * 1024 * 1024;

function say(text, kind) {
  const el = $("msg");
  el.textContent = text;
  el.className = "msg " + (kind || "");
}

async function load() {
  const params = new URLSearchParams(location.search);
  if (params.get("login") === "cancelado") say("Cancelaste la conexión con TikTok.", "err");
  const data = await fetch("/api/me").then((r) => r.json()).catch(() => ({}));
  const user = data.user;
  $("guest").hidden = !!user;
  $("panel").hidden = !user;
  $("navUser").textContent = user ? user.displayName : "";
  if (!user) return;
  $("nickname").textContent = user.displayName || "Cuenta de TikTok";
  if (user.avatarUrl) $("avatar").src = user.avatarUrl;
  else $("avatar").hidden = true;
  maxBytes = (data.maxMb || 64) * 1024 * 1024;
  $("maxMb").textContent = data.maxMb || 64;
}

$("file").addEventListener("change", () => {
  const f = $("file").files[0];
  $("fileName").textContent = f ? `${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)` : "Elegir archivo de video…";
  $("send").disabled = !f;
  say("");
  if (f && f.size > maxBytes) {
    say(`El video pesa más de ${maxBytes / 1024 / 1024} MB.`, "err");
    $("send").disabled = true;
  }
});

function upload(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.setRequestHeader("X-Requested-With", "fetch");
    xhr.setRequestHeader("Content-Type", file.type || "video/mp4");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) $("bar").value = Math.round((e.loaded / e.total) * 100);
    };
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch {}
      body.ok ? resolve(body) : reject(new Error(body.error || "Error al subir el video."));
    };
    xhr.onerror = () => reject(new Error("Error de red al subir el video."));
    xhr.send(file);
  });
}

async function waitStatus(publishId) {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const s = await fetch(`/api/status/${encodeURIComponent(publishId)}`).then((r) => r.json()).catch(() => ({}));
    if (s.status === "SEND_TO_USER_INBOX" || s.status === "PUBLISH_COMPLETE") return s;
    if (s.status === "FAILED") throw new Error(`TikTok no pudo procesar el video (${s.failReason || "sin detalle"}).`);
  }
  return null;
}

$("send").addEventListener("click", async () => {
  const file = $("file").files[0];
  if (!file) return;
  $("send").disabled = true;
  $("bar").hidden = false;
  $("bar").value = 0;
  say("Subiendo el video…");
  try {
    const { publishId } = await upload(file);
    say("Subido. TikTok lo está procesando…");
    const done = await waitStatus(publishId);
    say(
      done
        ? "Listo: abre la app de TikTok → Bandeja de entrada → Notificaciones del sistema para revisar y publicar tu borrador."
        : "El video se envió; TikTok tarda un poco en procesarlo. Revisa tu bandeja de TikTok en unos minutos.",
      "ok"
    );
  } catch (err) {
    say(err.message, "err");
  } finally {
    $("bar").hidden = true;
    $("send").disabled = false;
  }
});

$("logout").addEventListener("click", async () => {
  await post("/auth/logout");
  location.href = "/";
});

$("disconnect").addEventListener("click", async () => {
  if (!confirm("Se revocará el acceso a TikTok y se borrarán tus datos de ReelNext. ¿Continuar?")) return;
  const r = await post("/api/disconnect").then((x) => x.json()).catch(() => ({}));
  if (r.ok) location.href = "/";
  else say(r.error || "No se pudo desconectar.", "err");
});

load();
