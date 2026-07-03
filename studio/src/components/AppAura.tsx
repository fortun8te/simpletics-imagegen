// AppAura — a live WebGL2 canvas painted behind the WHOLE app (full viewport).
// A faithful dark+blue RESKIN of the "Undertones 4" reference: same recipe
// (Swirl → ChromaFlow cursor → FlutedGlass → FilmGrain), same structure and intensity,
// only the palette is swapped from light/white/purple/indigo to dark/black/blue.
// Cursor motion paints a directional blue trail that fades with momentum; the fluted
// glass refracts the field. The app's panels (sidebar / topbar / main) are glass overlays
// (backdrop-filter) so they read as frosted layers over this live background.
//
// The cursor is tracked at the WINDOW level (viewport-relative) so the whole app stays
// fully clickable while the effect responds to the pointer anywhere on screen.
//
// Robustness: falls back to a static CSS gradient if WebGL2 is unavailable, pauses when
// the tab is hidden, renders a single static frame under prefers-reduced-motion, caps DPR
// + FBO scale for perf, and cleans up its GL resources on unmount.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import s from './AppAura.module.css';

const VS = `#version 300 es
in vec2 pos; out vec2 vUv;
void main(){ vUv = pos*0.5+0.5; gl_Position = vec4(pos,0.,1.); }`;

const COMMON = `#version 300 es
precision highp float;
// "Undertones 4" recipe, THEME-AWARE palette: dark (near-black navy) ↔ light (soft white-blue),
// selected per-frame via the uLight uniform (0 = dark, 1 = light). The blues are shared — they pop
// on both bases. So light mode keeps the same live background + glass, just on a luminous white field.
const vec3 D_BASE  = vec3(0.012,0.015,0.035);   // #03040a  dark canvas — idle stays near-black
const vec3 L_BASE  = vec3(0.945,0.957,0.992);   // #f1f4fd  light canvas — idle stays near-white
const vec3 D_CLOUD = vec3(0.031,0.051,0.125);   // #08101f  dark navy clouding
const vec3 L_CLOUD = vec3(0.815,0.852,0.952);   // #d0d9f3  light blue clouding
// Accent-driven palette — uAccent is the Settings accent preset's base color (0..1 linear-ish
// sRGB, read live from the store; see lightRef/accentRef below for the same pattern already used
// for theme). The four palette anchors the rest of the shader expects (rich/deep/light/hot) are
// derived from uAccent by value so swapping the preset re-tints the whole field, not just a flat
// overlay: INDIGO darkens it, LIGHTB lightens it, HOTB pushes it toward a near-white core — the
// same relationships the original fixed blue palette had to each other.
uniform vec3 uAccent;
vec3 BLUE()   { return uAccent; }
vec3 INDIGO() { return uAccent * 0.62; }
vec3 LIGHTB() { return mix(uAccent, vec3(1.0), 0.55); }
vec3 HOTB()   { return mix(uAccent, vec3(1.0), 0.82); }
float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float vnoise(vec2 p){
  vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  float a=hash(i),b=hash(i+vec2(1,0)),c=hash(i+vec2(0,1)),d=hash(i+vec2(1,1));
  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
}
float fbm(vec2 p){ float v=0.,a=0.5; for(int i=0;i<4;i++){v+=a*vnoise(p);p=p*1.92+vec2(11.3,7.7);a*=0.5;} return v; }
`;

// ChromaFlow accumulation — verbatim reference logic; cursor motion injects a directional colour
// (recolored to blues) into a buffer that fades with momentum.
const ACCUM_FS = `${COMMON}
in vec2 vUv; out vec4 O;
uniform sampler2D uPrev;
uniform vec2  uRes;
uniform vec2  uMouse;
uniform vec2  uVel;
uniform float uSpeed;
uniform float uRadius;
uniform float uDecay;
void main(){
  vec4 prev = texture(uPrev, vUv);
  float inten = prev.a * uDecay;                 // momentum fade
  vec3  col   = prev.rgb;
  vec2 d = vUv - uMouse; d.x *= uRes.x/uRes.y;
  float r = length(d);
  float blob = exp(-pow(r/max(uRadius,1e-3), 2.0));
  // colour by direction of motion (L/R/U/D) — reference mapping recolored to blues.
  vec2 vd = uVel / max(uSpeed,1e-4);
  float wl=max(-vd.x,0.), wr=max(vd.x,0.), wu=max(vd.y,0.), wd=max(-vd.y,0.);
  float ws = wl+wr+wu+wd + 1e-4;
  vec3 inj = (LIGHTB()*wl + BLUE()*wr + HOTB()*wu + INDIGO()*wd)/ws;
  float amt = blob * smoothstep(0.012,0.12,uSpeed);  // paints at normal speeds, full strength well below a flick
  float nInten = clamp(inten + amt, 0.0, 1.0);
  col = mix(col, inj, clamp(amt/max(nInten,1e-3),0.0,1.0));
  O = vec4(col, nInten);
}`;

// Final composite — verbatim reference recipe (Swirl → ChromaFlow → FlutedGlass → FilmGrain), only
// the palette is recolored. Light-direction const is LDIR (not LIGHT) to avoid clashing with LIGHTB.
const FINAL_FS = `${COMMON}
in vec2 vUv; out vec4 O;
uniform sampler2D uTrail;
uniform vec2  uRes;
uniform float uT;
uniform float uLight;   // 0 = dark theme, 1 = light theme
const float FREQ  = 7.2;
const float REFR  = 4.0;
const float ABERR = 0.61;
const float SOFT  = 0.38;
const float GRAIN = 0.022;
const float GBIAS = 1.35;
const float ANGLE = -0.50;
const vec2  LDIR  = vec2(-0.80, 0.60);

/* ambient Swirl + ChromaFlow base + live cursor trail */
vec3 colorField(vec2 uv){
  // Theme-aware base + clouding (dark navy ↔ light white-blue), chosen by uLight.
  vec3 BASE  = mix(D_BASE, L_BASE, uLight);
  vec3 CLOUD = mix(D_CLOUD, L_CLOUD, uLight);
  float t = uT*0.03;   // slower ambient drift
  // Swirl: clouding lifts/varies the base (dark analog of the reference's white→gray).
  float swirl = fbm(uv*vec2(1.7,1.1) + vec2(t*0.5,-t*0.35));
  float swirl2= fbm(uv*vec2(3.2,2.0) + vec2(-t*0.4,t*0.6));
  // Amplitudes are theme-dependent: dark stays near-black/idle (unchanged), light pushes
  // toward the reference's vivid swirl + pool intensities, scaled for legibility on white.
  float swirlAmp1 = mix(0.12, 0.55, uLight);
  float swirlAmp2 = mix(0.05, 0.30, uLight);
  float poolAmp   = mix(0.06, 0.55, uLight);
  vec3 col = mix(BASE, CLOUD, smoothstep(0.30,0.80,swirl)*swirlAmp1);
  col = mix(col, mix(CLOUD,BLUE(),0.30), smoothstep(0.45,0.85,swirl2)*swirlAmp2);

  // ambient ChromaFlow blue toward the right (at-rest look) — reference shape.
  float blob = fbm(uv*vec2(2.0,2.6) + vec2(-t*0.8,t*0.5));
  float xr   = smoothstep(0.42,1.30, uv.x*0.58 + uv.y*0.60);   // bias the pool toward the TOP-right
  float pMask= smoothstep(0.55,1.12, xr*0.82 + blob*0.46);
  float core = smoothstep(0.50,1.20, xr);
  float pv   = smoothstep(0.05,1.05, core*0.75 + blob*0.45);
  vec3 chroma = mix(INDIGO(), BLUE(), pv);
  chroma = mix(chroma, mix(BLUE(),LIGHTB(),0.25), smoothstep(0.80,1.15,xr)*0.22);
  col = mix(col, chroma, pMask*poolAmp);   // dark: near-zero idle pool; light: clearly visible blue pool

  // super-subtle slow colour drift — a barely-perceptible blue shimmer crawling across the field,
  // so the near-black idle quietly breathes over ~tens of seconds instead of being dead-static.
  float drift = 0.5 + 0.5*sin(uT*0.085 + uv.x*2.1 - uv.y*1.3);
  col += BLUE() * drift * 0.013;

  // live cursor trail painted on top (reference blend; inj colours are bright so it reads on dark)
  vec4 tr = texture(uTrail, uv);
  col = mix(col, tr.rgb, tr.a);
  return col;
}

void main(){
  vec2 uv = vUv;
  float aspect = uRes.x/uRes.y;

  // FlutedGlass: vertical half-cylinder lenses, steep "/"
  vec2 p = (uv-0.5)*vec2(aspect,1.0);
  vec2 nAxis = vec2(cos(ANGLE), sin(ANGLE));
  float proj  = dot(p, nAxis);
  float x     = fract(proj*FREQ + uT*0.015)*2.0 - 1.0;     // -1..1 across flute
  float bend  = sin(x*1.5707963);
  float disp  = bend*REFR*(0.5/FREQ)*(0.5+0.5*SOFT);
  float ab    = disp*ABERR*0.5;
  vec2 dir = nAxis/vec2(aspect,1.0);
  vec2 rUV = uv + dir*disp;

  // chromatic aberration
  float r = colorField(rUV + dir*ab).r;
  vec3  g = colorField(rUV);
  float b = colorField(rUV - dir*ab).b;
  vec3 col = vec3(r, g.g, b);

  // lens shading (reference values)
  float nl   = dot(normalize(nAxis), normalize(LDIR));
  float spec = exp(-pow((x - nl*0.18)/0.52, 2.0));
  float body = x*(-nl)*0.035;
  float seam = smoothstep(0.80,1.0, abs(x));
  col += spec*0.045;
  col += body;
  col *= 1.0 - seam*0.06;
  col += smoothstep(0.93,1.0,abs(x))*0.02;

  // FilmGrain
  float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233))+uT)*43758.5453)*2.0-1.0;
  float luma  = clamp(dot(col, vec3(0.2126,0.7152,0.0722)),0.0,1.0);
  col += grain*pow((1.0-luma)+0.0001, GBIAS)*GRAIN;

  O = vec4(clamp(col,0.0,1.0),1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('AppAura shader:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function makeProgram(gl: WebGL2RenderingContext, fs: string): WebGLProgram | null {
  const p = gl.createProgram();
  if (!p) return null;
  const v = compile(gl, gl.VERTEX_SHADER, VS);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  if (!v || !f) { gl.deleteProgram(p); return null; }
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error('AppAura link:', gl.getProgramInfoLog(p));
    gl.deleteProgram(p);
    return null;
  }
  return p;
}

export default function AppAura() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Theme → uLight uniform, read live by the render loop (a ref so it updates without re-init).
  const theme = useStore((st) => st.ui.theme);
  const lightRef = useRef(theme === 'light' ? 1 : 0);
  useEffect(() => { lightRef.current = theme === 'light' ? 1 : 0; }, [theme]);

  // Reduce-motion gate — the user's in-app toggle OR the OS-level prefers-reduced-motion,
  // tracked LIVE (not just read once at mount) so flipping the Settings switch actually
  // stops the aura immediately instead of requiring a reload. When on, the canvas branch
  // below unmounts entirely (no GL context, no static frame, no gradient at all) — just the
  // flat app --bg shows through, matching what "reduce motion" should mean for a live
  // full-screen background, not merely slower/paused decoration.
  const reducedMotionPref = useStore((st) => st.ui.reducedMotion);
  const [systemReduced, setSystemReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setSystemReduced(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  const motionOff = reducedMotionPref || systemReduced;

  // Settings accent preset → uAccent uniform, same live-ref pattern as theme/lightRef above so
  // picking a new accent re-tints the background without tearing down and reinitializing GL.
  // Falls back to the shader's original royal-cobalt blue if no preset has been applied yet.
  const accentRGB = useStore((st) => st.ui.accentRGB);
  const DEFAULT_ACCENT: [number, number, number] = [0.157, 0.275, 0.925]; // matches the old BLUE const
  const accentRef = useRef<[number, number, number]>(
    accentRGB ? [accentRGB.r / 255, accentRGB.g / 255, accentRGB.b / 255] : DEFAULT_ACCENT,
  );
  useEffect(() => {
    accentRef.current = accentRGB
      ? [accentRGB.r / 255, accentRGB.g / 255, accentRGB.b / 255]
      : DEFAULT_ACCENT;
  }, [accentRGB]);

  useEffect(() => {
    // motionOff unmounts the <canvas> below (see JSX), so canvasRef is null and this
    // effect is a no-op until motion is re-enabled — no GL context ever spins up while off.
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const gl = canvas.getContext('webgl2', {
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      alpha: true,
    });
    if (!gl) return; // static CSS gradient fallback (see module css)

    const pAccum = makeProgram(gl, ACCUM_FS);
    const pFinal = makeProgram(gl, FINAL_FS);
    if (!pAccum || !pFinal) return;

    // quad
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const bindQuad = (p: WebGLProgram) => {
      const l = gl.getAttribLocation(p, 'pos');
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, 2, gl.FLOAT, false, 0, 0);
    };

    // ping-pong FBOs (rendered below device resolution — the field is a soft glow, upscaling hides it)
    const SCALE = 0.62;  // ~2.6x fewer shaded pixels than full res; still indistinguishable on the soft, blurred field
    let texA: WebGLTexture, texB: WebGLTexture, fboA: WebGLFramebuffer, fboB: WebGLFramebuffer;
    let W = 1, H = 1;

    const makeTex = (w: number, h: number) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const makeFbo = (t: WebGLTexture) => {
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      return f;
    };
    const alloc = () => {
      texA = makeTex(W, H); texB = makeTex(W, H); fboA = makeFbo(texA); fboB = makeFbo(texB);
      for (const f of [fboA, fboB]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, f);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);   // cap DPR at 1.5 for perf (soft field hides it)
      const cw = Math.max(1, Math.round(wrap.clientWidth * dpr * SCALE));
      const ch = Math.max(1, Math.round(wrap.clientHeight * dpr * SCALE));
      canvas.width = cw;
      canvas.height = ch;
      W = cw; H = ch;
      alloc();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    // Belt-and-braces: RO can miss the initial tick if the tab mounts at 0×0 (background
    // tab, restored session) — window resize catches the first real layout.
    window.addEventListener('resize', resize);

    // pointer — tracked at the WINDOW level, viewport-relative (0..1), so the whole app
    // stays clickable while the effect responds to the cursor anywhere on screen.
    let mx = 0.5, my = 0.4;          // smoothed position
    let tmx = 0.5, tmy = 0.4;        // target position
    let pmx = 0.5, pmy = 0.4;
    let vx = 0, vy = 0, sp = 0;
    // idle tracking — once the cursor stops moving for IDLE_MS, fade the live trail
    // intensity down to zero over IDLE_FADE_MS so the background settles back to idle
    // black instead of lingering on the last momentum-decayed frame. Purely additive:
    // does not alter the moving-cursor momentum/decay math above.
    const IDLE_MS = 1200;
    const IDLE_FADE_MS = 2800;
    let lastMoveAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let idleFade = 1;   // 1 = full live intensity, 0 = fully settled to idle black
    let lastFrameT = 0; // previous rAF timestamp (ms), for framerate-independent idle fade
    const onMove = (e: PointerEvent) => {
      tmx = e.clientX / Math.max(window.innerWidth, 1);
      tmy = 1.0 - e.clientY / Math.max(window.innerHeight, 1);
      lastMoveAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (settled && visible) {
        settled = false;
        raf = requestAnimationFrame(frame);
      }
    };
    window.addEventListener('pointermove', onMove, { passive: true });

    let raf = 0;
    let visible = true;
    let settled = false;
    const onVis = () => {
      visible = !document.hidden;
      if (visible && !raf) {
        settled = false;
        raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener('visibilitychange', onVis);

    // Uniform locations resolved ONCE per program — getUniformLocation every frame is a
    // needless per-frame GL round-trip (10+ lookups × 60fps while the cursor moves).
    const locs = (p: WebGLProgram, names: string[]) =>
      Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(p, n)]));
    const uA = locs(pAccum, ['uPrev', 'uRes', 'uAccent', 'uMouse', 'uVel', 'uSpeed', 'uRadius', 'uDecay']);
    const uF = locs(pFinal, ['uTrail', 'uRes', 'uAccent', 'uT', 'uLight']);

    const renderFrame = (t: number) => {
      // cursor position — smoother glide toward the pointer (more lag = silkier trail)
      // Faster cursor-follow: 0.08 → 0.16 roughly halves the frames-to-catch-up, so the
      // trail visibly tracks the pointer instead of trailing a beat behind on quick moves.
      mx += (tmx - mx) * 0.16;
      my += (tmy - my) * 0.16;
      const ivx = mx - pmx, ivy = my - pmy;
      // momentum — lighter smoothing (was 0.91/0.09) so direction changes register quicker,
      // still eased rather than snapping.
      vx = vx * 0.84 + ivx * 0.16;
      vy = vy * 0.84 + ivy * 0.16;
      sp = Math.hypot(vx, vy) * 60.0;
      pmx = mx; pmy = my;

      // idle fade — once the cursor has been still for IDLE_MS, ease idleFade down to 0
      // over roughly IDLE_FADE_MS (framerate-independent, via real dt) so the trail
      // intensity actively settles to idle black instead of lingering on uDecay's slow
      // per-frame fade alone. While not yet idle, idleFade snaps back to 1 immediately
      // (no effect on the in-motion look).
      const dt = lastFrameT ? Math.min(t - lastFrameT, 100) : 16.7; // ms, clamp tab-switch spikes
      lastFrameT = t;
      const idleFor = t - lastMoveAt;
      if (idleFor > IDLE_MS) {
        const k = 1 - Math.exp(-dt / (IDLE_FADE_MS / 4)); // ~4 time-constants ≈ full settle over IDLE_FADE_MS
        idleFade += (0 - idleFade) * k;
        if (idleFade < 0.001) idleFade = 0;
      } else {
        idleFade = 1;
      }

      // accumulation pass: read A → write B
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboB);
      gl.viewport(0, 0, W, H);
      gl.useProgram(pAccum);
      bindQuad(pAccum);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.uniform1i(uA.uPrev, 0);
      gl.uniform2f(uA.uRes, W, H);
      gl.uniform3f(uA.uAccent, accentRef.current[0], accentRef.current[1], accentRef.current[2]);
      gl.uniform2f(uA.uMouse, mx, my);
      gl.uniform2f(uA.uVel, vx, vy);
      gl.uniform1f(uA.uSpeed, sp);
      gl.uniform1f(uA.uRadius, 0.10);
      // Speed-dependent decay: at full speed the trail stays tight and local (0.90 — the
      // "in motion" feel), but as the cursor slows the buffer holds its ink (up to 0.975)
      // so stopping leaves a lingering wash that dissolves over seconds instead of
      // blinking away. idleFade then drives it fully to 0 after the idle window.
      const speedK = Math.min(1, sp * 6.0);
      const decay = (0.975 - 0.075 * speedK) * idleFade;
      gl.uniform1f(uA.uDecay, decay);    // quick fade — trail stays local, never floods/lingers
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // final pass: read B → screen
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.useProgram(pFinal);
      bindQuad(pFinal);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texB);
      gl.uniform1i(uF.uTrail, 0);
      gl.uniform2f(uF.uRes, W, H);
      gl.uniform3f(uF.uAccent, accentRef.current[0], accentRef.current[1], accentRef.current[2]);
      gl.uniform1f(uF.uT, t * 0.001);
      gl.uniform1f(uF.uLight, lightRef.current);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // swap
      const tx = texA; texA = texB; texB = tx;
      const fb = fboA; fboA = fboB; fboB = fb;
    };

    const frame = (t: number) => {
      if (!visible) { raf = 0; return; }
      renderFrame(t);
      const idleFor = t - lastMoveAt;
      if (idleFade <= 0.001 && idleFor > IDLE_MS + IDLE_FADE_MS) {
        settled = true;
        raf = 0;
        return;
      }
      settled = false;
      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('visibilitychange', onVis);
      gl.deleteProgram(pAccum);
      gl.deleteProgram(pFinal);
      gl.deleteBuffer(quad);
      gl.deleteTexture(texA);
      gl.deleteTexture(texB);
      gl.deleteFramebuffer(fboA);
      gl.deleteFramebuffer(fboB);
    };
  }, [motionOff]);

  // Motion fully off — no canvas, no GL, no static gradient frame either. Just the flat
  // app --bg (set on <html> in theme.css) shows through, which is what "reduce motion"
  // should mean for a live full-screen background rather than merely pausing decoration.
  if (motionOff) {
    return <div className={s.aura} aria-hidden="true" />;
  }

  return (
    <div ref={wrapRef} className={s.aura} aria-hidden="true">
      <canvas ref={canvasRef} className={s.canvas} />
      <div className={s.fallback} />
    </div>
  );
}
