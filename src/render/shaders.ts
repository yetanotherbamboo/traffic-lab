// GLSL ES 3.00 sources. Kept as TS strings so the bundle has no extra loaders.

/** Shared by every fragment shader: lighting, fog and construction-zone grading. */
const COMMON = /* glsl */ `
uniform vec3 uCamPos;
uniform vec3 uBg;
uniform vec2 uFog;        // start, end distance
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec4 uZone;       // centre x, z, half size x, z  (keep in sync with src/env/zone.ts)
uniform vec3 uZoneShape;  // corner radius, context scale, time (s)

vec3 applyFog(vec3 c, vec3 wp) {
  return mix(c, uBg, smoothstep(uFog.x, uFog.y, length(wp - uCamPos)));
}

vec3 shade(vec3 albedo, vec3 n, float ao) {
  float diff = max(dot(n, uSunDir), 0.0);
  vec3 hemi = mix(uGroundColor, uSkyColor, n.y * 0.5 + 0.5);
  return albedo * (hemi * 0.55 + uSunColor * diff * 0.62) * ao;
}

float sdRoundRect(vec2 p, vec2 h, float r) {
  vec2 q = abs(p) - h + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

/** Signed distance to the construction-area border (negative inside). */
float zoneDist(vec3 wp) {
  return sdRoundRect(wp.xz - uZone.xy, uZone.zw, uZoneShape.x);
}

/** 0 inside the visible city, 1 at/after the outer edge of the context ring. */
float zoneFade(vec3 wp) {
  vec2 h = uZone.zw * uZoneShape.y;
  float ring = min(h.x - uZone.z, h.y - uZone.w);
  float d = sdRoundRect(wp.xz - uZone.xy, h, uZoneShape.x * uZoneShape.y);
  return smoothstep(-ring * 0.8, 0.0, d);
}

/** Full colour in the construction area; desaturated, darker and fading to background outside. */
vec3 zoneGrade(vec3 c, vec3 wp) {
  float ctx = smoothstep(0.0, 10.0, zoneDist(wp));
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  vec3 g = mix(c, lum * vec3(0.9, 0.95, 1.06), 0.72 * ctx);
  g *= mix(1.0, 0.58, ctx);
  return mix(g, uBg, zoneFade(wp));
}

/** Soft pulsing line on the ground along the construction border. */
vec3 zoneBorder(vec3 c, vec3 wp) {
  float d = zoneDist(wp);
  float fw = max(fwidth(d), 0.02);
  float line = 1.0 - smoothstep(0.3, 0.3 + fw * 1.5, abs(d));
  float pulse = 0.55 + 0.25 * sin(uZoneShape.z * 2.2);
  return mix(c, vec3(1.0, 0.95, 0.82), line * pulse);
}
`;

export const groundVS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPos;
uniform mat4 uViewProj;
out vec3 vWorld;
void main() {
  vWorld = aPos;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

export const groundFS = /* glsl */ `#version 300 es
precision highp float;
in vec3 vWorld;
out vec4 outColor;
${COMMON}

// Anti-aliased grid line mask; fades out when lines get thinner than a pixel.
float grid(vec2 p, float spacing, float width) {
  vec2 d = abs(fract(p / spacing - 0.5) - 0.5) * spacing;
  vec2 fw = fwidth(p);
  vec2 l = 1.0 - smoothstep(vec2(width * 0.5), vec2(width * 0.5) + fw, d);
  float fade = 1.0 - smoothstep(spacing * 0.08, spacing * 0.3, max(fw.x, fw.y));
  return max(l.x, l.y) * fade;
}

void main() {
  vec2 p = vWorld.xz;
  vec3 col = vec3(0.74, 0.79, 0.62);
  float inside = 1.0 - smoothstep(-3.0, 0.0, zoneDist(vWorld)); // build grid only in the construction area
  col = mix(col, col * 0.9, grid(p, 10.0, 0.2) * inside);
  col = mix(col, col * 0.8, grid(p, 50.0, 0.5) * inside);
  col = shade(col, vec3(0.0, 1.0, 0.0), 1.0) * 1.12;
  col = zoneBorder(col, vWorld);
  outColor = vec4(applyFog(zoneGrade(col, vWorld), vWorld), 1.0);
}`;

export const roadVS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUV;      // x = lateral offset from centreline (m), y = distance along road (m)
layout(location = 6) in vec3 aLanes;   // forward lanes, backward lanes, lane width
layout(location = 7) in float aMat;
uniform mat4 uViewProj;
out vec3 vWorld;
out vec3 vNormal;
out vec2 vUV;
flat out vec3 vLanes;
flat out int vMat;
void main() {
  vWorld = aPos;
  vNormal = aNormal;
  vUV = aUV;
  vLanes = aLanes;
  vMat = int(aMat + 0.5);
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

export const roadFS = /* glsl */ `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in vec2 vUV;
flat in vec3 vLanes;
flat in int vMat;
out vec4 outColor;
${COMMON}

// Anti-aliased stripe of half-width hw centred at c; fades when thinner than a pixel.
float stripe(float x, float c, float hw) {
  float fw = max(fwidth(x), 1e-4);
  float m = 1.0 - smoothstep(hw - fw * 0.5, hw + fw * 0.5, abs(x - c));
  return m * clamp(hw * 2.0 / fw, 0.0, 1.0);
}

void main() {
  vec3 col;
  if (vMat == 1) {
    col = vec3(0.84, 0.81, 0.75);
  } else {
    col = vec3(0.40, 0.40, 0.43);
    if (vMat == 0) {
      float F = vLanes.x, B = vLanes.y, w = vLanes.z;
      float u = vUV.x, v = vUV.y;
      float L = B * w, R = F * w;
      float white = max(stripe(u, -L + 0.35, 0.08), stripe(u, R - 0.35, 0.08));
      float dash = step(fract(v / 9.0), 0.34);
      for (int k = 1; k < 8; k++) {
        float fk = float(k);
        if (fk < F) white = max(white, stripe(u, fk * w, 0.07) * dash);
        if (fk < B) white = max(white, stripe(u, -fk * w, 0.07) * dash);
      }
      float yellow = (F > 0.5 && B > 0.5) ? max(stripe(u, -0.14, 0.06), stripe(u, 0.14, 0.06)) : 0.0;
      col = mix(col, vec3(0.93, 0.92, 0.88), white * 0.9);
      col = mix(col, vec3(0.95, 0.78, 0.35), yellow * 0.9);
    }
  }
  col = shade(col, normalize(vNormal), 1.0);
  col = zoneBorder(col, vWorld);
  outColor = vec4(applyFog(zoneGrade(col, vWorld), vWorld), 1.0);
}`;

export const litInstancedVS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 3) in vec4 iPosRot;  // xyz = position, w = rotation around Y
layout(location = 4) in vec3 iScale;
layout(location = 5) in vec3 iColor;
layout(location = 8) in float iKind;   // 0 = plain, 1 = facade with windows, 2 = vehicle, 3 = emissive
uniform mat4 uViewProj;
out vec3 vWorld;
out vec3 vNormal;
out vec3 vColor;
out vec3 vLocal;       // scaled object-space position (metres), for window patterns
flat out vec3 vLocalN;
flat out vec2 vKindH;  // kind, object height
void main() {
  float c = cos(iPosRot.w), s = sin(iPosRot.w);
  vec3 p = aPos * iScale;
  vLocal = p;
  vLocalN = aNormal;
  vKindH = vec2(iKind, iScale.y);
  p = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
  vNormal = vec3(c * aNormal.x + s * aNormal.z, aNormal.y, -s * aNormal.x + c * aNormal.z);
  vWorld = p + iPosRot.xyz;
  vColor = iColor;
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}`;

export const litFS = /* glsl */ `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in vec3 vColor;
in vec3 vLocal;
flat in vec3 vLocalN;
flat in vec2 vKindH;
out vec4 outColor;
${COMMON}

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec3 col = vColor;
  int kind = int(vKindH.x + 0.5);
  if (kind == 3) { // emissive (signal lamps): no lighting
    outColor = vec4(applyFog(zoneGrade(col, vWorld), vWorld), 1.0);
    return;
  }
  if (kind == 2 && vLocal.y > vKindH.y * 0.52 && vLocalN.y < 0.5) {
    col = vec3(0.24, 0.29, 0.37); // vehicle cabin glass
  }
  if (kind == 1 && abs(vLocalN.y) < 0.5) {
    // Windows: one row per 3.2 m floor, one column per 2.6 m.
    float h = abs(vLocalN.x) > 0.5 ? vLocal.z : vLocal.x;
    vec2 cell = vec2(h / 2.6, vLocal.y / 3.2);
    vec2 f = fract(cell);
    vec2 fw = fwidth(cell);
    vec2 aa = max(fw, 1e-3);
    float wx = smoothstep(0.22 - aa.x, 0.22 + aa.x, f.x) * (1.0 - smoothstep(0.78 - aa.x, 0.78 + aa.x, f.x));
    float wy = smoothstep(0.32 - aa.y, 0.32 + aa.y, f.y) * (1.0 - smoothstep(0.8 - aa.y, 0.8 + aa.y, f.y));
    float win = wx * wy * step(0.9, vLocal.y) * step(vLocal.y, vKindH.y - 0.5);
    float lit = step(0.88, hash(floor(cell) + floor(vWorld.xz * 0.05)));  // a few warmly lit windows
    vec3 glass = mix(vec3(0.42, 0.5, 0.62), vec3(1.0, 0.82, 0.5), lit);
    float far = smoothstep(0.25, 0.6, max(fw.x, fw.y));  // blend to an average tone when tiny
    col = mix(mix(col, glass, win), col * 0.86, far);
  }
  float ao = mix(0.62, 1.0, clamp(vWorld.y / 4.0, 0.0, 1.0)); // cheap contact darkening near the ground
  col = shade(col, normalize(vNormal), ao);
  outColor = vec4(applyFog(zoneGrade(col, vWorld), vWorld), 1.0);
}`;

export const shadowVS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPos;     // unit quad on y = 0
layout(location = 3) in vec4 iPosRot;
layout(location = 4) in vec2 iSize;
layout(location = 5) in vec2 iParams;  // softness (m), opacity
uniform mat4 uViewProj;
out vec2 vP;
flat out vec2 vHalf;
flat out vec2 vParams;
out vec3 vWorld;
void main() {
  vec2 p = aPos.xz * iSize;
  vP = p;
  vHalf = iSize * 0.5;
  vParams = iParams;
  float c = cos(iPosRot.w), s = sin(iPosRot.w);
  vWorld = vec3(c * p.x + s * p.y, 0.0, -s * p.x + c * p.y) + iPosRot.xyz;
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}`;

export const shadowFS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vP;
flat in vec2 vHalf;
flat in vec2 vParams;
in vec3 vWorld;
out vec4 outColor;
${COMMON}
void main() {
  vec2 q = abs(vP) - max(vHalf - vParams.x, vec2(0.0));
  float d = length(max(q, 0.0));
  float a = vParams.y * (1.0 - smoothstep(0.0, vParams.x, d));
  a *= 1.0 - zoneFade(vWorld);
  outColor = vec4(0.16, 0.18, 0.26, a);
}`;

/**
 * Soft glow sprites (signal lamps, blinkers), premultiplied alpha: camera-facing quads that never shrink
 * below `iMinAngle` radians on screen, so lights stay visible when zoomed out.
 */
export const glowVS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPos;      // unit quad on y = 0 (x, z in [-0.5, 0.5])
layout(location = 3) in vec4 iPosSize;  // centre, world size (m)
layout(location = 5) in vec3 iColor;    // colour × intensity
layout(location = 8) in float iMinAngle;
uniform mat4 uViewProj;
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
out vec2 vUv;
out vec3 vColor;
out vec3 vWorld;
void main() {
  vec3 c = iPosSize.xyz;
  vec3 toCam = uCamPos - c;
  float dist = length(toCam);
  float size = max(iPosSize.w, dist * iMinAngle);
  // Pulled towards the camera so the sprite isn't cut by the lamp's own housing.
  vec3 p = c + toCam / dist * min(0.6, size * 0.5) + (uCamRight * aPos.x + uCamUp * aPos.z) * size;
  vUv = aPos.xz * 2.0;
  vColor = iColor;
  vWorld = c;
  gl_Position = uViewProj * vec4(p, 1.0);
}`;

export const glowFS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
in vec3 vColor;
in vec3 vWorld;
out vec4 outColor;
${COMMON}
void main() {
  float r2 = dot(vUv, vUv);
  if (r2 >= 1.0) discard;
  // Premultiplied: a saturated core that covers the ground (so colour reads on light pastel
  // surfaces, where pure additive light washes out to white) plus a soft additive halo.
  float core = exp(-r2 * 7.0) * (1.0 - r2);
  float halo = 0.35 * exp(-r2 * 2.5) * (1.0 - r2);
  float k = (1.0 - zoneFade(vWorld)) * (1.0 - smoothstep(uFog.x, uFog.y, length(vWorld - uCamPos)));
  outColor = vec4(vColor * (core * 1.15 + halo) * k, core * 0.85 * k);
}`;
