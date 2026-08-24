import * as ort from 'onnxruntime-web';

ort.env.wasm.proxy = false; 

let session = null;
let downsampleRatio = 0.25;

let r1 = null;
let r2 = null;
let r3 = null;
let r4 = null;

const initRecurrentState = () => {
  r1 = new ort.Tensor('float32', new Float32Array(1 * 16 * 144 * 256), [1, 16, 144, 256]);
  r2 = new ort.Tensor('float32', new Float32Array(1 * 20 * 72 * 128),  [1, 20, 72,  128]);
  r3 = new ort.Tensor('float32', new Float32Array(1 * 40 * 36 * 64),   [1, 40, 36,  64]);
  r4 = new ort.Tensor('float32', new Float32Array(1 * 64 * 18 * 32),   [1, 64, 18,  32]);
};

const bitmapToTensor = (bitmap) => {
  const canvas = new OffscreenCanvas(256, 144);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, 256, 144);
  const imageData = ctx.getImageData(0, 0, 256, 144);
  
  const { data } = imageData;
  const tensor = new Float32Array(3 * 144 * 256);
  for (let i = 0; i < 144 * 256; i++) {
    tensor[i]                   = data[i * 4]     / 255.0; // R
    tensor[144 * 256 + i]       = data[i * 4 + 1] / 255.0; // G
    tensor[144 * 256 * 2 + i]   = data[i * 4 + 2] / 255.0; // B
  }
  return new ort.Tensor('float32', tensor, [1, 3, 144, 256]);
};

self.onmessage = async (e) => {
  const { type, payload } = e.data;

  if (type === 'init') {
    try {
      session = await ort.InferenceSession.create(payload.modelUrl || '/models/rvm_mobilenetv3_fp16.onnx', {
        executionProviders: ['webgl'],
        graphOptimizationLevel: 'all',
      });
      downsampleRatio = payload.downsampleRatio ?? 0.25;
      initRecurrentState();
      self.postMessage({ type: 'ready' });
    } catch (error) {
      self.postMessage({ type: 'error', error: error.message });
    }
    return;
  }

  if (type === 'segment') {
    const { bitmap, id } = payload;
    if (!session || !r1 || !r2 || !r3 || !r4) return;

    try {
      const src = bitmapToTensor(bitmap);
      const dsRatio = new ort.Tensor('float32', Float32Array.from([downsampleRatio]));

      const results = await session.run({
        src, r1i: r1, r2i: r2, r3i: r3, r4i: r4,
        downsample_ratio: dsRatio,
      });

      r1 = results['r1o'];
      r2 = results['r2o'];
      r3 = results['r3o'];
      r4 = results['r4o'];

      self.postMessage({
        type: 'result',
        id,
        pha: results['pha'],
        fgr: results['fgr'],
      });
      src.dispose();
      bitmap.close();
    } catch (error) {
      self.postMessage({ type: 'error', error: error.message, id });
      bitmap.close();
    }
  }

  if (type === 'reset') {
    initRecurrentState();
  }
};
