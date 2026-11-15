// A MapLibre custom layer that draws one RGBA image over a Web Mercator box.
// Pixels are uploaded from a typed array (not from a canvas element), and the compare slider is a shader clip,
// so moving the slider never re-uploads anything.
import { EARTH_R } from './geo.js';

const VS = `attribute vec2 a_uv; uniform mat4 u_matrix; uniform vec4 u_box; varying vec2 v_uv;
void main() { v_uv = a_uv; gl_Position = u_matrix * vec4(mix(u_box.x, u_box.z, a_uv.x), mix(u_box.y, u_box.w, a_uv.y), 0.0, 1.0); }`;
const FS = `precision mediump float; uniform sampler2D u_tex; uniform float u_opacity; uniform vec2 u_clip; varying vec2 v_uv;
void main() { if (v_uv.x < u_clip.x || v_uv.x > u_clip.y) discard; vec4 c = texture2D(u_tex, v_uv); gl_FragColor = vec4(c.rgb * c.a, c.a) * u_opacity; }`;

const WORLD = 2 * Math.PI * EARTH_R;

/** Web Mercator metres -> MapLibre's 0..1 world box [left, top, right, bottom] for a raster descriptor. */
export function mercBox(r) {
  return [0.5 + r.x0 / WORLD, 0.5 - r.y0 / WORLD, 0.5 + (r.x0 + r.w * r.px) / WORLD, 0.5 - (r.y0 - r.h * r.px) / WORLD];
}

export class RasterGL {
  constructor(id, opacity = 0.86) {
    this.id = id; this.type = 'custom'; this.renderingMode = '2d';
    this.opacity = opacity; this.clip = [0, 1]; this.visible = false; this.pending = null; this.box = [0, 0, 1, 1]; this.key = null;
  }

  onAdd(map, gl) {
    this.map = map;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.prog = p;
    this.loc = { uv: gl.getAttribLocation(p, 'a_uv'), matrix: gl.getUniformLocation(p, 'u_matrix'), box: gl.getUniformLocation(p, 'u_box'), tex: gl.getUniformLocation(p, 'u_tex'), opacity: gl.getUniformLocation(p, 'u_opacity'), clip: gl.getUniformLocation(p, 'u_clip') };
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.tex = gl.createTexture();
    this.vao = gl.createVertexArray ? gl.createVertexArray() : null;
  }

  /** rgba: Uint8ClampedArray or Uint8Array of w*h*4 straight-alpha pixels, row 0 = north. `key` skips repeat uploads. */
  setImage(key, rgba, w, h, box) {
    if (key !== this.key) { this.pending = { rgba, w, h }; this.key = key; }
    this.box = box; this.visible = true;
    if (this.map) this.map.triggerRepaint();
  }

  hide() { this.visible = false; if (this.map) this.map.triggerRepaint(); }

  show() { if (this.key) { this.visible = true; if (this.map) this.map.triggerRepaint(); } }

  setClip(a, b) { this.clip = [a, b]; if (this.map) this.map.triggerRepaint(); }

  render(gl, matrix) {
    if (!this.visible || !this.prog) return;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (this.pending) {
      const { rgba, w, h } = this.pending;
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.pending = null;
    }
    gl.useProgram(this.prog);
    if (this.vao) gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(this.loc.uv);
    gl.vertexAttribPointer(this.loc.uv, 2, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix4fv(this.loc.matrix, false, matrix);
    gl.uniform4fv(this.loc.box, this.box);
    gl.uniform1i(this.loc.tex, 0);
    gl.uniform1f(this.loc.opacity, this.opacity);
    gl.uniform2fv(this.loc.clip, this.clip);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (this.vao) gl.bindVertexArray(null);
  }
}
