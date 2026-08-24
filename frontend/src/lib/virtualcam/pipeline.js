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

export class CanvasFallbackPipeline {
  constructor(track, options) {
    this.track = track;
    this.worker = new RVMWorkerClient(options);
    this.compositor = new WebGLCompositor();
    this.background = options.background || { type: 'transparent' };
    
    // Create elements for video playback and output canvas
    this.videoElement = document.createElement('video');
    this.videoElement.autoplay = true;
    this.videoElement.playsInline = true;
    this.videoElement.muted = true;
    
    this.outputCanvas = document.createElement('canvas');
    this.outputCanvas.width = 640;
    this.outputCanvas.height = 480;
    this.outputCtx = this.outputCanvas.getContext('2d');
    
    this.isRunning = false;
    this.animationFrameId = null;
    
    // Use an OffscreenCanvas if available, otherwise just use standard Canvas
    this.processingCanvas = typeof OffscreenCanvas !== 'undefined' 
      ? new OffscreenCanvas(640, 480) 
      : document.createElement('canvas');
    this.processingCtx = this.processingCanvas.getContext('2d', { willReadFrequently: true });
  }

  async init() {
    await this.worker.init();
    await this.compositor.setBackground(this.background);
    
    // Bind the track to the video element
    const stream = new MediaStream([this.track]);
    this.videoElement.srcObject = stream;
    
    await new Promise((resolve) => {
      this.videoElement.onloadedmetadata = () => {
        this.videoElement.play();
        resolve();
      };
    });
    
    this.outputCanvas.width = this.videoElement.videoWidth || 640;
    this.outputCanvas.height = this.videoElement.videoHeight || 480;
    if (this.processingCanvas.width !== undefined) {
      this.processingCanvas.width = this.outputCanvas.width;
      this.processingCanvas.height = this.outputCanvas.height;
    }
  }

  async processLoop() {
    if (!this.isRunning) return;

    try {
      if (this.videoElement.readyState >= 2) {
        // Draw video frame to processing canvas
        this.processingCtx.drawImage(this.videoElement, 0, 0, this.outputCanvas.width, this.outputCanvas.height);
        
        // Convert to ImageBitmap or use the canvas directly for the worker
        let sourceImage;
        if (typeof createImageBitmap !== 'undefined') {
          sourceImage = await createImageBitmap(this.processingCanvas);
        } else {
          sourceImage = this.processingCanvas; // Note: worker expects bitmap, might need adaptation in worker.js
        }
        
        const { pha } = await this.worker.segment(sourceImage);
        const composited = await this.compositor.composite(this.videoElement, pha);
        
        // Draw composited result to output canvas
        this.outputCtx.clearRect(0, 0, this.outputCanvas.width, this.outputCanvas.height);
        this.outputCtx.drawImage(composited, 0, 0);
        
        if (sourceImage.close) sourceImage.close();
      }
    } catch (e) {
      console.error('VirtualCam CanvasFallback error', e);
    }
    
    this.animationFrameId = requestAnimationFrame(this.processLoop.bind(this));
  }

  start() {
    this.isRunning = true;
    this.processLoop();
  }

  get outputTrack() {
    return this.outputCanvas.captureStream(30).getVideoTracks()[0];
  }

  setBackground(bg) {
    this.background = bg;
    this.compositor.setBackground(bg);
  }

  destroy() {
    this.isRunning = false;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    if (this.videoElement.srcObject) {
      this.videoElement.srcObject.getTracks().forEach(t => t.stop());
    }
    this.worker.terminate();
    this.compositor.destroy();
  }
}
