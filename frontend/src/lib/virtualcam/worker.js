import * as ort from 'onnxruntime-web';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/';
ort.env.wasm.proxy = false;

let session = null;
let downsampleRatio = 0.25;

// Input resolution
const INP_W = 256, INP_H = 144;

// Recurrent states — initialized as [1,1,1,1] scalars.
// Confirmed working via local onnxruntime-node test: the model broadcasts from this shape.
let r1 = null, r2 = null, r3 = null, r4 = null;

const initRecurrentState = () => {
  r1 = new ort.Tensor('float32', new Float32Array([0]), [1, 1, 1, 1]);
  r2 = new ort.Tensor('float32', new Float32Array([0]), [1, 1, 1, 1]);
  r3 = new ort.Tensor('float32', new Float32Array([0]), [1, 1, 1, 1]);
  r4 = new ort.Tensor('float32', new Float32Array([0]), [1, 1, 1, 1]);
};

const bitmapToTensor = (bitmap) => {
  const canvas = new OffscreenCanvas(INP_W, INP_H);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, INP_W, INP_H);
  const imageData = ctx.getImageData(0, 0, INP_W, INP_H);
  const { data } = imageData;
  const N = INP_H * INP_W;
  const tensor = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) {
    tensor[i]       = data[i * 4]     / 255.0;
    tensor[N + i]   = data[i * 4 + 1] / 255.0;
    tensor[N*2 + i] = data[i * 4 + 2] / 255.0;
  }
  return new ort.Tensor('float32', tensor, [1, 3, INP_H, INP_W]);
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
      console.log('[RVM worker] Model loaded. Inputs:', session.inputNames);
      initRecurrentState();
      self.postMessage({ type: 'ready' });
    } catch (error) {
      console.error('[RVM worker] Init error:', error);
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

      try { prevR1.dispose(); prevR2.dispose(); prevR3.dispose(); prevR4.dispose(); } catch (_) {}

      self.postMessage({ type: 'result', id, pha: results['pha'], fgr: results['fgr'] });

      src.dispose();
      dsRatio.dispose();
      bitmap.close();
    } catch (error) {
      console.error('[RVM worker] Segment error:', error);
      self.postMessage({ type: 'error', id, error: error.message || String(error) });
      try { bitmap.close(); } catch (_) {}
    }
  }

  if (type === 'reset') {
    initRecurrentState();
  }
};
