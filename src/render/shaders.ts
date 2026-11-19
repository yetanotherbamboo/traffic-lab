// GLSL ES 3.00 sources. Kept as TS strings so the bundle has no extra loaders.

const FOG = /* glsl */ `
uniform vec3 uCamPos;
uniform vec3 uFogColor;
uniform vec2 uFog; // start, end distance
vec3 applyFog(vec3 c, vec3 wp) {
  float f = smoothstep(uFog.x, uFog.y, length(wp - uCamPos));
  return mix(c, uFogColor, f);
}`;

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
${FOG}

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
  vec3 col = vec3(0.74, 0.78, 0.63);
  col = mix(col, col * 0.88, grid(p, 10.0, 0.2));
  col = mix(col, col * 0.76, grid(p, 50.0, 0.5));
  outColor = vec4(applyFog(col, vWorld), 1.0);
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
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
${FOG}

// Anti-aliased stripe of half-width hw centred at c; fades when thinner than a pixel.
float stripe(float x, float c, float hw) {
  float fw = max(fwidth(x), 1e-4);
  float m = 1.0 - smoothstep(hw - fw * 0.5, hw + fw * 0.5, abs(x - c));
  return m * clamp(hw * 2.0 / fw, 0.0, 1.0);
}

void main() {
  vec3 asphalt = vec3(0.40, 0.40, 0.43);
  vec3 col;
  if (vMat == 1) {
    col = vec3(0.84, 0.81, 0.75);
  } else {
    col = asphalt;
    if (vMat == 0) {
      float F = vLanes.x, B = vLanes.y, w = vLanes.z;
      float u = vUV.x, v = vUV.y;
      float L = B * w, R = F * w;
      float white = 0.0, yellow = 0.0;
      white = max(white, stripe(u, -L + 0.35, 0.08));
      white = max(white, stripe(u, R - 0.35, 0.08));
      float dash = step(fract(v / 9.0), 0.34);
      for (int k = 1; k < 8; k++) {
        float fk = float(k);
        if (fk < F) white = max(white, stripe(u, fk * w, 0.07) * dash);
        if (fk < B) white = max(white, stripe(u, -fk * w, 0.07) * dash);
      }
      if (F > 0.5 && B > 0.5) {
        yellow = max(stripe(u, -0.14, 0.06), stripe(u, 0.14, 0.06));
      }
      col = mix(col, vec3(0.93, 0.92, 0.88), white * 0.9);
      col = mix(col, vec3(0.95, 0.78, 0.35), yellow * 0.9);
    }
  }
  vec3 n = normalize(vNormal);
  float diff = max(dot(n, uSunDir), 0.0);
  vec3 hemi = mix(uGroundColor, uSkyColor, n.y * 0.5 + 0.5);
  vec3 lit = col * (hemi * 0.55 + uSunColor * diff * 0.6);
  outColor = vec4(applyFog(lit, vWorld), 1.0);
}`;

export const litInstancedVS =/* glsl */ `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 3) in vec4 iPosRot;  // xyz = position, w = rotation around Y
layout(location = 4) in vec3 iScale;
layout(location = 5) in vec3 iColor;
uniform mat4 uViewProj;
out vec3 vWorld;
out vec3 vNormal;
out vec3 vColor;
out float vAO;
void main() {
  float c = cos(iPosRot.w), s = sin(iPosRot.w);
  vec3 p = aPos * iScale;
  p = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
  vNormal = vec3(c * aNormal.x + s * aNormal.z, aNormal.y, -s * aNormal.x + c * aNormal.z);
  vWorld = p + iPosRot.xyz;
  vColor = iColor;
  vAO = mix(0.62, 1.0, clamp(p.y / 4.0, 0.0, 1.0)); // cheap contact darkening near the ground
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}`;

export const litFS = /* glsl */ `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in vec3 vColor;
in float vAO;
out vec4 outColor;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
${FOG}
void main() {
  vec3 n = normalize(vNormal);
  float diff = max(dot(n, uSunDir), 0.0);
  vec3 hemi = mix(uGroundColor, uSkyColor, n.y * 0.5 + 0.5);
  vec3 col = vColor * (hemi * 0.55 + uSunColor * diff * 0.6) * vAO;
  outColor = vec4(applyFog(col, vWorld), 1.0);
}`;
