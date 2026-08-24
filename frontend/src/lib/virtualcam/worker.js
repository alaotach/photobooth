import * as ort from 'onnxruntime-web';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/';
ort.env.wasm.proxy = false;

let session = null;
let downsampleRatio = 0.25;

// Recurrent states — initialized from the model's own input metadata
let r1 = null, r2 = null, r3 = null, r4 = null;

/**
 * Create a zero tensor whose shape is read from the loaded session's input metadata.
 */
const zeroTensorFromMeta = (inputMeta) => {
  const dims = inputMeta.dims.map(d => (typeof d === 'bigint' ? Number(d) : (d > 0 ? d : 1)));
  const size = dims.reduce((a, b) => a * b, 1);
  return new ort.Tensor('float32', new Float32Array(size), dims);
};

const initRecurrentState = () => {
  const inputs = session.inputNames;
  const meta = session.inputMetadata || {};

  // Fall back to reading from session if inputMetadata not available (ORT compat)
  const getMeta = (name) => {
    if (session.inputMetadata) return session.inputMetadata[name];
    // ORT Web exposes inputs via handler — use dims from the ONNX model spec
    return null;
  };

  const r1Meta = getMeta('r1i');
  const r2Meta = getMeta('r2i');
  const r3Meta = getMeta('r3i');
  const r4Meta = getMeta('r4i');

  if (r1Meta && r1Meta.dims) {
    r1 = zeroTensorFromMeta(r1Meta);
    r2 = zeroTensorFromMeta(r2Meta);
    r3 = zeroTensorFromMeta(r3Meta);
    r4 = zeroTensorFromMeta(r4Meta);
    console.log('[worker] r1 shape from model:', r1.dims);
  } else {
    // Hard fallback — use 1-element zero tensors (model will broadcast)
    // This avoids shape mismatch entirely; ORT will expand as needed
    r1 = new ort.Tensor('float32', new Float32Array([0]), [1, 1, 1, 1]);
    r2 = new ort.Tensor('float32', new Float32Array([0]), [1, 1, 1, 1]);
    r3 = new ort.Tensor('float32', new Float32Array([0]), [1, 1, 1, 1]);
    r4 = new ort.Tensor('float32', new Float32Array([0]), [1, 1, 1, 1]);
    console.warn('[worker] Could not read recurrent state dims from model, using 1x1x1x1 zero init');
  }
};

const bitmapToTensor = (bitmap) => {
  const W = 320, H = 240;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, W, H);
  const imageData = ctx.getImageData(0, 0, W, H);
  const { data } = imageData;
  const tensor = new Float32Array(3 * H * W);
  for (let i = 0; i < H * W; i++) {
    tensor[i]           = data[i * 4]     / 255.0; // R
    tensor[H * W + i]   = data[i * 4 + 1] / 255.0; // G
    tensor[H * W*2 + i] = data[i * 4 + 2] / 255.0; // B
  }
  return new ort.Tensor('float32', tensor, [1, 3, H, W]);
};

self.onmessage = async (e) => {
  const { type, payload } = e.data;

  if (type === 'init') {
    try {
      session = await ort.InferenceSession.create(
        payload.modelUrl || '/models/rvm_mobilenetv3_fp32.onnx',
        { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }
      );
      downsampleRatio = payload.downsampleRatio ?? 0.25;
      console.log('[worker] Model loaded. Input names:', session.inputNames);
      initRecurrentState();
      self.postMessage({ type: 'ready' });
    } catch (error) {
      console.error('Worker init error:', error);
      self.postMessage({ type: 'error', error: error.message || String(error) });
    }
    return;
  }

  if (type === 'segment') {
    const { bitmap, id } = payload;
    if (!session || !r1) return;

    try {
      const src = bitmapToTensor(bitmap);
      const dsRatio = new ort.Tensor('float32', Float32Array.from([downsampleRatio]));

      const prevR1 = r1, prevR2 = r2, prevR3 = r3, prevR4 = r4;

      const results = await session.run({
        src, r1i: r1, r2i: r2, r3i: r3, r4i: r4,
        downsample_ratio: dsRatio,
      });

      r1 = results['r1o'];
      r2 = results['r2o'];
      r3 = results['r3o'];
      r4 = results['r4o'];

      try { prevR1.dispose(); prevR2.dispose(); prevR3.dispose(); prevR4.dispose(); } catch(_) {}

      self.postMessage({ type: 'result', id, pha: results['pha'], fgr: results['fgr'] });
      src.dispose();
      bitmap.close();
    } catch (error) {
      console.error('Worker segment error:', error);
      self.postMessage({ type: 'error', id, error: error.message || String(error) });
      try { bitmap.close(); } catch(_) {}
    }
  }

  if (type === 'reset') {
    initRecurrentState();
  }
};
