import { VirtualCamPipeline, CanvasFallbackPipeline } from './pipeline.js';

export const isSupported = () => {
  return (
    typeof MediaStreamTrackProcessor !== 'undefined' &&
    typeof MediaStreamTrackGenerator !== 'undefined'
  );
};

export async function createVirtualCam(inputStream, options) {
  const videoTracks = inputStream.getVideoTracks();
  if (videoTracks.length === 0) {
    throw new Error('No video track found in input stream');
  }

  const track = videoTracks[0];
  let pipeline;
  
  if (!isSupported()) {
    console.warn('VirtualCam: Insertable Streams not supported, falling back to Canvas processor');
    pipeline = new CanvasFallbackPipeline(track, options);
  } else {
    pipeline = new VirtualCamPipeline(track, options);
  }

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
