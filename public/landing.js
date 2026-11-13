// Portada de reelnext.io (diseño 3D, 2026-11-13). Todo se carga desde este mismo sitio (la política de seguridad no deja
// otra cosa): la librería 3D está en /vendor y los videos en /media. Si el 3D no se puede usar, quedan los celulares en CSS.
(function () {
  "use strict";
  const VERSION_MEDIA = "v1"; // si cambia un video, se sube con otro número para que Cloudflare no muestre el viejo
  // Los videos están en media/, al lado de este archivo (en reelnext.io es /media; en el estudio local, /inicio-archivos/media)
  const base = (document.currentScript && document.currentScript.src ? document.currentScript.src : location.href).replace(/[^/]*$/, "");
  const video = (k) => `${base}media/${k}-${VERSION_MEDIA}.mp4`;
  const foto = (k) => `${base}media/${k}-${VERSION_MEDIA}.jpg`;
  const quieto = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Videos de la página: la foto se ve enseguida y el video se pide recién cuando está por aparecer en pantalla
  const cercanos = new IntersectionObserver(
    (es) =>
      es.forEach((e) => {
        if (!e.isIntersecting) return;
        const v = e.target;
        v.src = video(v.dataset.v);
        v.play().catch(() => {});
        cercanos.unobserve(v);
      }),
    { rootMargin: "300px 0px" }
  );
  document.querySelectorAll("video[data-v]").forEach((v) => {
    v.muted = true;
    v.poster = foto(v.dataset.v);
    cercanos.observe(v);
  });
  // Algunos navegadores no dejan arrancar videos solos: arrancan con el primer toque, clic o movimiento de la página
  const arrancarTodo = () => document.querySelectorAll("video").forEach((v) => v.src && v.paused && v.play().catch(() => {}));
  ["pointerdown", "touchstart", "scroll", "keydown"].forEach((ev) => addEventListener(ev, arrancarTodo, { passive: true }));

  // Barra con fondo al bajar
  const barra = document.getElementById("barra");
  const fondoBarra = () => barra.classList.toggle("solida", scrollY > 30);
  addEventListener("scroll", fondoBarra, { passive: true });
  fondoBarra();

  // Secciones que terminan de aparecer al bajar (ya se ven antes, solo se asientan)
  const io = new IntersectionObserver(
    (es) =>
      es.forEach((e) => {
        if (!e.isIntersecting) return;
        const hermanos = [...e.target.parentElement.children].filter((x) => x.classList.contains("aparece"));
        e.target.style.transitionDelay = `${Math.max(0, hermanos.indexOf(e.target)) * 90}ms`;
        e.target.classList.add("visto");
        io.unobserve(e.target);
      }),
    { threshold: 0.15 }
  );
  document.querySelectorAll(".aparece").forEach((el) => io.observe(el));

  // Tarjetas que se inclinan con el mouse
  document.querySelectorAll(".tarjeta").forEach((t) => {
    t.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse") return;
      const r = t.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      t.style.transform = `rotateY(${x * 16}deg) rotateX(${-y * 16}deg) translateY(-6px)`;
    });
    t.addEventListener("pointerleave", () => (t.style.transform = ""));
  });

  // ---------- Portada 3D ----------
  const canvas = document.getElementById("escena3d");
  const portada = document.getElementById("portada");
  const sin3d = () => document.body.classList.add("sin3d");
  if (!window.THREE || !canvas) return sin3d();
  const THREE = window.THREE;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (e) {
    return sin3d();
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0f1113, 7, 22);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);

  // Piso de grilla que avanza
  const grilla = new THREE.GridHelper(80, 80, 0xd1fe17, 0xd1fe17);
  grilla.material.transparent = true;
  grilla.material.opacity = 0.2;
  grilla.position.y = -2.1;
  scene.add(grilla);

  // Partículas con los colores de la marca
  const n = 500;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const paleta = [0xd1fe17, 0x22d3ee, 0xf472b6, 0xd1fe17].map((c) => new THREE.Color(c));
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 22;
    pos[i * 3 + 1] = Math.random() * 9 - 2;
    pos[i * 3 + 2] = -Math.random() * 16 + 3;
    const c = paleta[i % 4];
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  const geoP = new THREE.BufferGeometry();
  geoP.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geoP.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const puntos = new THREE.Points(geoP, new THREE.PointsMaterial({ size: 0.045, vertexColors: true, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(puntos);

  // Rectángulo redondeado (y sus coordenadas de textura de 0 a 1)
  function forma(w, h, r) {
    const s = new THREE.Shape();
    const x = -w / 2;
    const y = -h / 2;
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y);
    s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + h - r);
    s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    s.lineTo(x + r, y + h);
    s.quadraticCurveTo(x, y + h, x, y + h - r);
    s.lineTo(x, y + r);
    s.quadraticCurveTo(x, y, x + r, y);
    return s;
  }
  function conUV(geo, w, h) {
    const p = geo.attributes.position;
    const uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
      uv[i * 2] = p.getX(i) / w + 0.5;
      uv[i * 2 + 1] = p.getY(i) / h + 0.5;
    }
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    return geo;
  }
  // Brillo detrás de cada celular
  function brillo(hex) {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, hex + "cc");
    gr.addColorStop(1, hex + "00");
    g.fillStyle = gr;
    g.fillRect(0, 0, 128, 128);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    sp.scale.set(3.4, 4.6, 1);
    sp.position.z = -0.35;
    return sp;
  }

  const W = 1.0, H = 1.96, SW = 0.9, SH = 1.6;
  const videos = [];
  function celular(clave, color) {
    const g = new THREE.Group();
    const cuerpo = new THREE.Mesh(
      new THREE.ExtrudeGeometry(forma(W, H, 0.15), { depth: 0.07, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 3, curveSegments: 10 }),
      new THREE.MeshStandardMaterial({ color: 0x0f0e16, metalness: 0.55, roughness: 0.4, emissive: new THREE.Color(color), emissiveIntensity: 0.06 })
    );
    cuerpo.position.z = -0.07;
    g.add(cuerpo);
    const v = document.createElement("video");
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    v.preload = "auto";
    v.src = video(clave);
    videos.push(v);
    // Primero la foto del video; cuando el video arranca de verdad, la pantalla pasa al video
    const tFoto = new THREE.TextureLoader().load(foto(clave));
    tFoto.encoding = THREE.sRGBEncoding;
    const mat = new THREE.MeshBasicMaterial({ map: tFoto, toneMapped: false });
    v.addEventListener("playing", () => {
      if (mat.map instanceof THREE.VideoTexture) return;
      const tex = new THREE.VideoTexture(v);
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.encoding = THREE.sRGBEncoding;
      mat.map = tex;
      mat.needsUpdate = true;
    });
    v.play().catch(() => {});
    const pantalla = new THREE.Mesh(conUV(new THREE.ShapeGeometry(forma(SW, SH, 0.1), 10), SW, SH), mat);
    pantalla.position.z = 0.025;
    g.add(pantalla);
    const borde = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(forma(W + 0.04, H + 0.04, 0.17).getPoints(60)), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 }));
    borde.position.z = 0.03;
    g.add(borde);
    g.add(brillo("#" + new THREE.Color(color).getHexString()));
    return g;
  }
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const l1 = new THREE.PointLight(0x22d3ee, 1.0, 20);
  l1.position.set(-4, 3, 4);
  scene.add(l1);
  const l2 = new THREE.PointLight(0xf472b6, 0.9, 20);
  l2.position.set(4, 2, 4);
  scene.add(l2);

  const grupo = new THREE.Group();
  scene.add(grupo);
  const tels = [
    { m: celular("short", 0x22d3ee), x: -1.32, y: -0.05, z: -0.55, ry: 0.5, rz: 0.06, f: 0 },
    { m: celular("holistico", 0xf472b6), x: 0, y: 0.18, z: 0.25, ry: 0, rz: 0, f: 2.1 },
    { m: celular("versus", 0xfb923c), x: 1.32, y: -0.05, z: -0.55, ry: -0.5, rz: -0.06, f: 4.2 },
  ];
  tels.forEach((t) => grupo.add(t.m));

  // Tamaño: en la computadora los celulares ocupan la mitad derecha; en el celular, una franja debajo del texto
  let angosto = false;
  function medir() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    angosto = portada.clientWidth < 760;
    camera.fov = angosto ? 44 : 38;
    camera.updateProjectionMatrix();
    camera.position.set(0, 0.2, angosto ? 7 : 6.6);
    const medio = Math.tan((camera.fov * Math.PI) / 360) * camera.position.z * camera.aspect;
    const lugar = angosto ? medio * 2 * 0.9 : medio * 0.86;
    grupo.scale.setScalar(Math.min(1.05, lugar / 3.9));
    grupo.position.set(angosto ? 0 : medio * 0.5, angosto ? 0.15 : 0, 0);
  }
  medir();
  addEventListener("resize", medir);

  // El mouse o la inclinación del celular mueven la escena
  const obj = { x: 0, y: 0 };
  const act = { x: 0, y: 0 };
  addEventListener("pointermove", (e) => {
    obj.x = (e.clientX / innerWidth - 0.5) * 2;
    obj.y = (e.clientY / innerHeight - 0.5) * 2;
  }, { passive: true });
  addEventListener("deviceorientation", (e) => {
    if (e.gamma == null) return;
    obj.x = Math.max(-1, Math.min(1, e.gamma / 30));
    obj.y = Math.max(-1, Math.min(1, (e.beta - 45) / 30));
  }, { passive: true });

  // Si el navegador no deja arrancar los videos solos, un botón para tocarlos
  const tocar = document.getElementById("tocar");
  setTimeout(() => {
    if (videos.some((v) => v.paused)) tocar.style.display = "block";
  }, 2500);
  tocar.addEventListener("click", () => {
    videos.forEach((v) => v.play().catch(() => {}));
    arrancarTodo();
    tocar.style.display = "none";
  });

  let visible = true;
  new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(portada);
  const reloj = new THREE.Clock();
  (function cuadro() {
    requestAnimationFrame(cuadro);
    if (!visible) return;
    const t = reloj.getElapsedTime();
    act.x += (obj.x - act.x) * 0.05;
    act.y += (obj.y - act.y) * 0.05;
    // Al bajar, los celulares se abren y giran (en el celular no: ahí se ven justamente al bajar)
    const p = angosto ? 0 : Math.min(1, Math.max(0, scrollY / (portada.clientHeight * 0.8)));
    tels.forEach((tl, i) => {
      const abre = 1 + p * 0.55;
      tl.m.position.set(tl.x * abre, tl.y + (quieto ? 0 : Math.sin(t * 1.1 + tl.f) * 0.09) - p * (i === 1 ? 0.2 : 0.6), tl.z - p * 0.8);
      tl.m.rotation.set(-p * 0.25, tl.ry * (1 + p * 0.8), tl.rz);
    });
    grupo.rotation.y = act.x * 0.2 + (quieto ? 0 : Math.sin(t * 0.25) * 0.06);
    grupo.rotation.x = act.y * 0.12;
    if (!quieto) {
      grilla.position.z = (t * 0.9) % 1;
      puntos.rotation.y = t * 0.02;
    }
    renderer.render(scene, camera);
  })();
})();
