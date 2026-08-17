import React, { useRef, useEffect } from 'react';

export default function TransparentVideo({ stream, isLocal, depth = 1.0, lighting = { tint: [1, 1, 1], luminance: 0.5, warmth: 0 } }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!stream || !videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (video.srcObject !== stream) {
      video.srcObject = stream;
      video.play().catch(e => {
        if (e.name !== 'AbortError') console.error('Video play error:', e);
      });
    }

    let animationId;

    if (isLocal) {
      // Local stream is already natively transparent from the ML pipeline.
      // Simple 2D draw — no chroma key, zero CPU cost.
      const ctx = canvas.getContext('2d', { alpha: true });
      let sized = false;
      const loop = () => {
        if (video.videoWidth > 0) {
          // Only set canvas dimensions once — resizing destroys the context state
          if (!sized) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            sized = true;
          }
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(video, 0, 0);
        }
        animationId = requestAnimationFrame(loop);
      };
      loop();
      return () => cancelAnimationFrame(animationId);
    }

    // ── Remote stream: WebGL Chroma Key (GPU fragment shader) ──────────────────
    // Bug fix: premultipliedAlpha: true to match browser compositor expectations.
    // premultipliedAlpha: false + CSS compositing = desaturated/grainy colors on the left feed.
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true });

    if (!gl) {
      // Fallback to CPU path if WebGL unavailable
      console.warn('WebGL unavailable, falling back to CPU chroma key');
      const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: true });
      let sized = false;
      const loop = () => {
        if (video.videoWidth > 0) {
          if (!sized) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; sized = true; }
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(video, 0, 0);
          const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const d = frame.data;
          for (let i = 0; i < d.length; i += 4) {
            const magenta = (d[i] + d[i+2]) / 2 - d[i+1];
            if (magenta > 15) {
              d[i+3] = magenta > 50 ? 0 : Math.max(0, 255 - ((magenta - 15) * (255 / 35)));
              if (magenta <= 50) { d[i] = Math.min(d[i], d[i+1] + 10); d[i+2] = Math.min(d[i+2], d[i+1] + 10); }
            }
          }
          ctx.putImageData(frame, 0, 0);
        }
        animationId = requestAnimationFrame(loop);
      };
      loop();
      return () => cancelAnimationFrame(animationId);
    }

    // Vertex shader: full-screen quad
    const vert = `
      attribute vec2 a_pos;
      varying vec2 v_uv;
      void main() {
      attribute vec2 a_position;
      attribute vec2 a_texCoord;
      varying vec2 v_texCoord;
      void main() {
        v_texCoord = a_texCoord;
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `;

    // Fragment shader: GPU GREEN chroma key + despill + premultiplied alpha output
    const frag = `
      precision mediump float;
      uniform sampler2D u_tex;
      uniform vec3 u_tint;
      uniform float u_luminance;
      uniform float u_strength;
      varying vec2 v_texCoord;

      vec3 colorGrade(vec3 rgb) {
        vec3 multiplied = rgb * u_tint;
        vec3 graded = mix(rgb, multiplied, u_strength);
        float personLum = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
        float exposureShift = 1.0 + (u_luminance - personLum) * u_strength * 0.5;
        graded *= clamp(exposureShift, 0.7, 1.3);
        return clamp(graded, 0.0, 1.0);
      }

      void main() {
        vec4 c = texture2D(u_tex, v_texCoord);
        float max_rb = max(c.r, c.b);
        float green_diff = c.g - max_rb;
        float alpha = 1.0 - smoothstep(0.02, 0.15, green_diff);
        vec3 rgb = c.rgb;
        if (green_diff > 0.0) {
          rgb.g = max_rb;
        }
        rgb = colorGrade(rgb);
        gl_FragColor = vec4(rgb * alpha, alpha);
      }
    `;

    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('Shader compile error:', gl.getShaderInfoLog(s));
      }
      return s;
    };

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vert));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('Shader link error:', gl.getProgramInfoLog(prog));
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 1,
       1, -1, 1, 1,
      -1,  1, 0, 0,
       1,  1, 1, 0
    ]), gl.STATIC_DRAW);

    const pos = gl.getAttribLocation(prog, 'a_position');
    const coord = gl.getAttribLocation(prog, 'a_texCoord');
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(coord, 2, gl.FLOAT, false, 16, 8);
    gl.enableVertexAttribArray(pos);
    gl.enableVertexAttribArray(coord);

    const uTint = gl.getUniformLocation(prog, 'u_tint');
    const uLuminance = gl.getUniformLocation(prog, 'u_luminance');
    const uStrength = gl.getUniformLocation(prog, 'u_strength');

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    let sized = false;

    const loop = () => {
      if (video.videoWidth > 0) {
        if (!sized) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          gl.viewport(0, 0, canvas.width, canvas.height);
          sized = true;
        }
        gl.clear(gl.COLOR_BUFFER_BIT);
        
        // Pass ambient lighting variables to shader
        gl.useProgram(prog);
        gl.uniform3fv(uTint, lighting.tint);
        gl.uniform1f(uLuminance, lighting.luminance);
        gl.uniform1f(uStrength, 0.35); // 35% blend — subtle, not garish

        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      animationId = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      cancelAnimationFrame(animationId);
      gl.deleteTexture(tex);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
    };
  }, [stream, isLocal]);

  // zIndex: higher depth = rendered on top.
  const zIndex = Math.round(depth * 100);

  return (
    <>
      <video
        ref={videoRef}
        playsInline
        muted={isLocal}
        className="hidden"
      />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full object-cover pointer-events-none scale-x-[-1]"
        style={{
          zIndex: zIndex
        }}
      />
    </>
  );
}
