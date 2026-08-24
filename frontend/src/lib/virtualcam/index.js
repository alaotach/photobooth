import { VirtualCamPipeline } from './pipeline.js';

export const isSupported = () => {
  return (
    typeof MediaStreamTrackProcessor !== 'undefined' &&
    typeof MediaStreamTrackGenerator !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined'
  );
};

const createFallbackSession = (inputStream, options) => {
  return {
    outputStream: inputStream,
    setBackground: () => { console.warn('VirtualCam (fallback): setBackground ignored'); },
    destroy: () => {},
  };
};

export async function createVirtualCam(inputStream, options) {
  if (!isSupported()) {
    console.warn('VirtualCam: Insertable Streams not supported, falling back to passthrough');
    return createFallbackSession(inputStream, options);
  }
  
  const videoTracks = inputStream.getVideoTracks();
  if (videoTracks.length === 0) {
    throw new Error('No video track found in input stream');
  }

  const track = videoTracks[0];
  const pipeline = new VirtualCamPipeline(track, options);
  await pipeline.init();
  pipeline.start();
  
  const outputStream = new MediaStream([pipeline.outputTrack]);
  
  // Mix in audio tracks if they exist
  inputStream.getAudioTracks().forEach(t => outputStream.addTrack(t));

  return {
    outputStream,
    setBackground: (bg) => pipeline.setBackground(bg),
    destroy: () => pipeline.destroy(),
  };
}
