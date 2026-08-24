export class WebGLCompositor {
  constructor(options = {}) {
    this.canvas = typeof OffscreenCanvas !== 'undefined' 
      ? new OffscreenCanvas(options.width || 640, options.height || 480)
      : document.createElement('canvas');
      
    if (this.canvas.width === undefined && options.width) {
      this.canvas.width = options.width;
      this.canvas.height = options.height;
    }

    this.gl = this.canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    this.initShaders();
    this.initTextures();
    this.bgImageElement = null;
    this.bgType = 'transparent';
    this.bgColor = '#000000';
    this.uniforms = {};
  }

  initShaders() {
    const gl = this.gl;
    const vert = `#version 300 es
      in vec2 a_pos;
      out vec2 v_uv;
      void main() {
        v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `;

    const frag = `#version 300 es
      precision mediump float;
      uniform sampler2D u_fgr;     
      uniform sampler2D u_pha;     
      uniform sampler2D u_bg;      
      uniform vec3 u_tint;         
      uniform float u_tint_strength;
      uniform int u_bg_type; 
      uniform vec4 u_bg_color;
      out vec4 fragColor;
      in vec2 v_uv;

      vec3 colorGrade(vec3 rgb) {
        vec3 graded = mix(rgb, rgb * u_tint, u_tint_strength);
        return clamp(graded, 0.0, 1.0);
      }

      void main() {
        vec4 fgr = texture(u_fgr, v_uv);
        float alpha = texture(u_pha, v_uv).r;
        
        alpha = smoothstep(0.3, 0.7, alpha);
        
        vec4 bg = vec4(0.0);
        if (u_bg_type == 1 || u_bg_type == 3) {
           bg = texture(u_bg, v_uv);
        } else if (u_bg_type == 2) {
           bg = u_bg_color;
        }
        
        vec3 gradedFgr = colorGrade(fgr.rgb);
        
        if (u_bg_type == 0) {
          // Transparent background: output premultiplied foreground directly
          fragColor = vec4(gradedFgr * alpha, alpha);
        } else {
          // Solid background: mix background and foreground, then output opaque
          vec3 rgb = mix(bg.rgb, gradedFgr, alpha);
          fragColor = vec4(rgb, 1.0);
        }
      }
    `;

    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) || 'Shader error');
      }
      return shader;
    };

    this.program = gl.createProgram();
    gl.attachShader(this.program, compile(gl.VERTEX_SHADER, vert));
    gl.attachShader(this.program, compile(gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(this.program);
    
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
       1,  1
    ]), gl.STATIC_DRAW);

    const pos = gl.getAttribLocation(this.program, 'a_pos');
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(pos);

    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_fgr'), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_pha'), 1);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_bg'), 2);
    
    this.uniforms = {
      bgType:       gl.getUniformLocation(this.program, 'u_bg_type'),
      bgColor:      gl.getUniformLocation(this.program, 'u_bg_color'),
      tint:         gl.getUniformLocation(this.program, 'u_tint'),
      tintStrength: gl.getUniformLocation(this.program, 'u_tint_strength'),
    };
    
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  initTextures() {
    const gl = this.gl;
    const createTex = (filter = gl.LINEAR) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      return t;
    };
    this.fgrTexture = createTex(gl.LINEAR);
    // Mask uses LINEAR now that it's an 8-bit LUMINANCE texture (float textures weren't filterable)
    this.maskTexture = createTex(gl.LINEAR);
    this.bgTexture = createTex(gl.LINEAR);
  }

  hexToRgba(hex) {
    const c = hex.replace('#', '');
    return [
      parseInt(c.substr(0, 2), 16) / 255,
      parseInt(c.substr(2, 2), 16) / 255,
      parseInt(c.substr(4, 2), 16) / 255,
      1.0
    ];
  }

  async setBackground(bg) {
    this.bgType = bg.type;
    this.bgImageElement = null;

    if (bg.type === 'image' || bg.type === 'video') {
      if (typeof bg.src === 'string') {
        if (bg.type === 'image') {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.src = bg.src;
          await new Promise((resolve) => {
            img.onload = resolve;
            img.onerror = () => {
              console.error('Failed to load background image:', bg.src);
              this.bgType = 'transparent'; // Fallback if image fails
              resolve();
            };
          });
          if (this.bgType === 'image') {
            this.bgImageElement = img;
          }
        }
      } else {
        this.bgImageElement = bg.src;
      }
    } else if (bg.type === 'color') {
      this.bgColor = bg.color;
    }
  }

  async composite(frame, pha) {
    const gl = this.gl;
    
    // VideoFrame uses .displayWidth/.displayHeight; ImageBitmap uses .width/.height
    const frameW = frame.displayWidth ?? frame.width;
    const frameH = frame.displayHeight ?? frame.height;

    if (!frameW || !frameH) return; // Guard against invalid frames
    
    if (this.canvas.width !== frameW || this.canvas.height !== frameH) {
      this.canvas.width = frameW;
      this.canvas.height = frameH;
      // No need to recreate shaders/textures on canvas resize; just update viewport
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fgrTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);

    
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    // Convert float32 mask to Uint8 LUMINANCE — avoids needing OES_texture_float_linear extension
    const maskW = pha.dims[3];
    const maskH = pha.dims[2];
    const maskU8 = new Uint8Array(maskW * maskH);
    for (let i = 0; i < pha.data.length; i++) {
      maskU8[i] = Math.min(255, Math.max(0, pha.data[i] * 255 + 0.5));
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, maskW, maskH, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, maskU8);
    
    let bgTypeInt = 0;
    if (this.bgType === 'image' || this.bgType === 'video') {
      bgTypeInt = 1;
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.bgTexture);
      if (this.bgImageElement) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.bgImageElement);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0,0,0,255]));
      }
    } else if (this.bgType === 'color') {
      bgTypeInt = 2;
    } else if (this.bgType === 'blur') {
      bgTypeInt = 3;
      
      if (!this.blurCanvas) {
        this.blurCanvas = typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(frameW, frameH)
          : document.createElement('canvas');
        if (this.blurCanvas.width !== undefined) {
           this.blurCanvas.width = frameW;
           this.blurCanvas.height = frameH;
        }
        this.blurCtx = this.blurCanvas.getContext('2d');
      } else if (this.blurCanvas.width !== frameW || this.blurCanvas.height !== frameH) {
        this.blurCanvas.width = frameW;
        this.blurCanvas.height = frameH;
      }
      
      this.blurCtx.filter = 'blur(20px)';
      this.blurCtx.drawImage(frame, 0, 0, frameW, frameH);
      this.blurCtx.filter = 'none';
      
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.bgTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.blurCanvas);
    }

    gl.useProgram(this.program);
    gl.uniform1i(this.uniforms.bgType, bgTypeInt);
    
    if (bgTypeInt === 2) {
      const color = this.hexToRgba(this.bgColor);
      gl.uniform4fv(this.uniforms.bgColor, color);
    }

    gl.uniform3fv(this.uniforms.tint, [1,1,1]);
    gl.uniform1f(this.uniforms.tintStrength, 0.0);
    
    // Explicitly clear the backbuffer to transparent black before drawing.
    // Without this, transparent pixels (alpha 0) will blend with the uncleared previous frame,
    // causing a permanent ghosting/accumulation effect.
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    
    return this.canvas;
  }

  destroy() {
    const gl = this.gl;
    gl.deleteTexture(this.fgrTexture);
    gl.deleteTexture(this.maskTexture);
    gl.deleteTexture(this.bgTexture);
    gl.deleteProgram(this.program);
  }
}
