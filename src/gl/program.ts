import type { Mat4, Vec3 } from '../core/math';

function compile(gl: WebGL2RenderingContext, type: number, src: string, label: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh) ?? '';
    const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(3)}: ${l}`).join('\n');
    gl.deleteShader(sh);
    throw new Error(`[${label}] ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader error:\n${log}\n${numbered}`);
  }
  return sh;
}

/** Linked shader program with cached uniform locations. */
export class Program {
  readonly handle: WebGLProgram;
  private readonly locs = new Map<string, WebGLUniformLocation | null>();

  constructor(private readonly gl: WebGL2RenderingContext, vs: string, fs: string, label = 'program') {
    const p = gl.createProgram()!;
    const v = compile(gl, gl.VERTEX_SHADER, vs, label);
    const f = compile(gl, gl.FRAGMENT_SHADER, fs, label);
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    gl.deleteShader(v);
    gl.deleteShader(f);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error(`[${label}] link error: ${gl.getProgramInfoLog(p)}`);
    }
    this.handle = p;
  }

  use(): this {
    this.gl.useProgram(this.handle);
    return this;
  }

  private loc(name: string): WebGLUniformLocation | null {
    let l = this.locs.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.handle, name);
      this.locs.set(name, l);
    }
    return l;
  }

  mat4(name: string, m: Mat4): this {
    this.gl.uniformMatrix4fv(this.loc(name), false, m);
    return this;
  }
  vec3(name: string, v: Vec3): this {
    this.gl.uniform3f(this.loc(name), v[0], v[1], v[2]);
    return this;
  }
  vec2(name: string, x: number, y: number): this {
    this.gl.uniform2f(this.loc(name), x, y);
    return this;
  }
  float(name: string, x: number): this {
    this.gl.uniform1f(this.loc(name), x);
    return this;
  }

  dispose(): void {
    this.gl.deleteProgram(this.handle);
  }
}
