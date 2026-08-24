import { RVMWorkerClient } from './worker-client.js';
import { WebGLCompositor } from './compositor.js';

export class VirtualCamPipeline {
  constructor(track, options) {
    this.processor = new MediaStreamTrackProcessor({ track });
    this.generator = new MediaStreamTrackGenerator({ kind: 'video' });
    this.worker = new RVMWorkerClient(options);
    this.compositor = new WebGLCompositor();
    this.background = options.background || { type: 'transparent' };

    this.transformer = new TransformStream({
      transform: this.processFrame.bind(this)
    });
  }

  async init() {
    await this.worker.init();
    await this.compositor.setBackground(this.background);
  }

  async processFrame(frame, controller) {
    try {
      const bitmap = await createImageBitmap(frame);
      const { pha } = await this.worker.segment(bitmap);

      const composited = await this.compositor.composite(frame, pha);

      controller.enqueue(new VideoFrame(composited, {
        timestamp: frame.timestamp,
        duration: frame.duration ?? undefined,
      }));

      frame.close();
      composited.close();
    } catch (e) {
      console.error('VirtualCam processFrame error', e);
      controller.enqueue(frame);
    }
  }

  start() {
    this.processor.readable
      .pipeThrough(this.transformer)
      .pipeTo(this.generator.writable);
  }

  get outputTrack() {
    return this.generator;
  }

  setBackground(bg) {
    this.background = bg;
    this.compositor.setBackground(bg);
  }

  destroy() {
    this.worker.terminate();
    this.compositor.destroy();
  }
}
