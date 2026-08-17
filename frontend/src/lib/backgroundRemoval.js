// --- Cached contexts (never call getContext inside hot paths) ---
let localCtxCache = null;
let webrtcCtxCache = null;

// --- Downscale input canvas for ML inference ---
let downscaleCanvas = null;
let downscaleCtx = null;

// --- Temporal smoothing: blend masks across frames to kill flicker ---
let prevMaskCanvas = null;
let prevMaskCtx = null;

// --- Frame targets ---
import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';

let imageSegmenter;
let currentLocalCanvas;
let currentWebrtcCanvas;
let currentVideo;
let maskCanvas;
let maskCtx;
let maskImageData;

export const loadMLModel = async () => {
  if (imageSegmenter) return;

  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm"
  );
  
  imageSegmenter = await ImageSegmenter.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite",
      delegate: "CPU" // CPU with XNNPACK is incredibly fast and 100% stable on all mobile browsers, avoiding GPU crash loops
    },
    runningMode: "VIDEO",
    outputCategoryMask: false,
    outputConfidenceMasks: true
  });
};

export const processVideoFrame = async (video, localCanvas, webrtcCanvas, onDepthUpdate) => {
  if (video.videoWidth === 0) return;

  currentVideo = video;
  currentLocalCanvas = localCanvas;
  currentWebrtcCanvas = webrtcCanvas;

  // Sync canvas sizes to the video stream! (Crucial for WebRTC stream capture)
  if (localCanvas.width !== video.videoWidth || localCanvas.height !== video.videoHeight) {
    localCanvas.width = video.videoWidth;
    localCanvas.height = video.videoHeight;
    webrtcCanvas.width = video.videoWidth;
    webrtcCanvas.height = video.videoHeight;
  }

  // If ML failed to load or is still initializing, don't leave the screen black!
  // Just draw the raw video directly to both canvases.
  if (!imageSegmenter) {
    const localCtx = localCanvas.getContext('2d');
    const webrtcCtx = webrtcCanvas.getContext('2d');
    localCtx.clearRect(0, 0, localCanvas.width, localCanvas.height);
    localCtx.drawImage(video, 0, 0, localCanvas.width, localCanvas.height);
    webrtcCtx.clearRect(0, 0, webrtcCanvas.width, webrtcCanvas.height);
    webrtcCtx.drawImage(video, 0, 0, webrtcCanvas.width, webrtcCanvas.height);
    return;
  }

  // DYNAMIC DOWNSCALING (Fixes mobile lag WITHOUT causing background bleed)
  if (!downscaleCanvas) {
    downscaleCanvas = document.createElement('canvas');
    downscaleCtx = downscaleCanvas.getContext('2d');
  }

  // Calculate dimensions while STRICTLY preserving aspect ratio
  const maxDim = 256;
  let targetW, targetH;
  
  if (video.videoWidth >= video.videoHeight) {
    targetW = maxDim;
    targetH = Math.round(maxDim * (video.videoHeight / video.videoWidth));
  } else {
    targetH = maxDim;
    targetW = Math.round(maxDim * (video.videoWidth / video.videoHeight));
  }

  if (downscaleCanvas.width !== targetW || downscaleCanvas.height !== targetH) {
    downscaleCanvas.width = targetW;
    downscaleCanvas.height = targetH;
  }

  downscaleCtx.drawImage(video, 0, 0, targetW, targetH);

  try {
    const startTimeMs = performance.now();
    imageSegmenter.segmentForVideo(downscaleCanvas, startTimeMs, (result) => {
      const localCtx = currentLocalCanvas.getContext('2d');
      const webrtcCtx = currentWebrtcCanvas.getContext('2d');

      if (!result.confidenceMasks || result.confidenceMasks.length === 0) {
        // Fallback if the AI fails on this frame
        localCtx.clearRect(0, 0, currentLocalCanvas.width, currentLocalCanvas.height);
        localCtx.drawImage(video, 0, 0, currentLocalCanvas.width, currentLocalCanvas.height);
        webrtcCtx.clearRect(0, 0, currentWebrtcCanvas.width, currentWebrtcCanvas.height);
        webrtcCtx.drawImage(video, 0, 0, currentWebrtcCanvas.width, currentWebrtcCanvas.height);
        return;
      }

      // If the model returns 2 masks, index 1 is person. If 1 mask, it's the person mask.
      const mpMask = result.confidenceMasks[result.confidenceMasks.length - 1];
      const width = mpMask.width;
      const height = mpMask.height;
      const maskFloatArray = mpMask.getAsFloat32Array();

      if (!maskCanvas) {
        maskCanvas = document.createElement('canvas');
        maskCtx = maskCanvas.getContext('2d');
      }
      if (maskCanvas.width !== width || maskCanvas.height !== height) {
        maskCanvas.width = width;
        maskCanvas.height = height;
        maskImageData = maskCtx.createImageData(width, height);
      }

      // Convert Float32Array to ImageData and calculate Depth
      const data = maskImageData.data;
      let maxY = 0;
      let hasPerson = false;
      
      for (let i = 0; i < maskFloatArray.length; i++) {
        const alpha = maskFloatArray[i] * 255;
        const j = i * 4;
        data[j + 0] = 255;
        data[j + 1] = 255;
        data[j + 2] = 255;
        data[j + 3] = alpha;
        
        // Depth Calculation: find lowest pixel (highest Y) where person is solidly visible
        if (maskFloatArray[i] > 0.3) {
           const y = Math.floor(i / width);
           if (y > maxY) maxY = y;
           hasPerson = true;
        }
      }
      maskCtx.putImageData(maskImageData, 0, 0);

      // Transmit depth (normalized 0.0 to 1.0)
      if (onDepthUpdate && hasPerson) {
         onDepthUpdate(maxY / height);
      }

      // --- COMPOSITING ---
      // 1. LOCAL CANVAS
      localCtx.clearRect(0, 0, currentLocalCanvas.width, currentLocalCanvas.height);
      localCtx.drawImage(maskCanvas, 0, 0, currentLocalCanvas.width, currentLocalCanvas.height);
      localCtx.globalCompositeOperation = 'source-in';
      localCtx.drawImage(video, 0, 0, currentLocalCanvas.width, currentLocalCanvas.height);
      localCtx.globalCompositeOperation = 'source-over';

      // 2. WEBRTC CANVAS
      webrtcCtx.clearRect(0, 0, currentWebrtcCanvas.width, currentWebrtcCanvas.height);
      webrtcCtx.drawImage(maskCanvas, 0, 0, currentWebrtcCanvas.width, currentWebrtcCanvas.height);
      webrtcCtx.globalCompositeOperation = 'source-in';
      webrtcCtx.drawImage(video, 0, 0, currentWebrtcCanvas.width, currentWebrtcCanvas.height);
      
      // Fill GREEN behind the person
      webrtcCtx.globalCompositeOperation = 'destination-over';
      webrtcCtx.fillStyle = '#00FF00';
      webrtcCtx.fillRect(0, 0, currentWebrtcCanvas.width, currentWebrtcCanvas.height);
      webrtcCtx.globalCompositeOperation = 'source-over';
    });
  } catch (error) {
    console.error('ML Processing Error:', error);
  }
};
