/** One float attribute in an interleaved buffer. `loc` matches `layout(location=N)` in GLSL. */
export interface Attrib {
  loc: number;
  size: number;
}

function setupAttribs(gl: WebGL2RenderingContext, attribs: Attrib[], divisor: number): void {
  const stride = attribs.reduce((s, a) => s + a.size, 0) * 4;
  let offset = 0;
  for (const a of attribs) {
    gl.enableVertexAttribArray(a.loc);
    gl.vertexAttribPointer(a.loc, a.size, gl.FLOAT, false, stride, offset);
    gl.vertexAttribDivisor(a.loc, divisor);
    offset += a.size * 4;
  }
}

/**
 * Indexed mesh in a VAO, with an optional per-instance buffer so many copies
 * (vehicles, buildings, trees) render in a single draw call.
 */
export class Mesh {
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;
  private readonly ibo: WebGLBuffer;
  private readonly indexType: number;
  private readonly indexCount: number;
  private instanceVbo: WebGLBuffer | null = null;
  private instanceCapacityBytes = 0;
  instanceCount = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    vertices: Float32Array,
    layout: Attrib[],
    indices: Uint16Array | Uint32Array,
    instanceLayout?: Attrib[],
  ) {
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    this.vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    setupAttribs(gl, layout, 0);

    if (instanceLayout) {
      this.instanceVbo = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVbo);
      setupAttribs(gl, instanceLayout, 1);
    }

    this.ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    this.indexType = indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    this.indexCount = indices.length;

    gl.bindVertexArray(null);
  }

  /** Upload per-instance data; the buffer only grows, so steady-state updates don't reallocate. */
  setInstances(data: Float32Array, count: number): void {
    const gl = this.gl;
    if (!this.instanceVbo) throw new Error('Mesh has no instance layout');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVbo);
    if (data.byteLength > this.instanceCapacityBytes) {
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      this.instanceCapacityBytes = data.byteLength;
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    }
    this.instanceCount = count;
  }

  draw(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    if (this.instanceVbo) {
      if (this.instanceCount > 0) {
        gl.drawElementsInstanced(gl.TRIANGLES, this.indexCount, this.indexType, 0, this.instanceCount);
      }
    } else {
      gl.drawElements(gl.TRIANGLES, this.indexCount, this.indexType, 0);
    }
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.vbo);
    gl.deleteBuffer(this.ibo);
    if (this.instanceVbo) gl.deleteBuffer(this.instanceVbo);
  }
}
