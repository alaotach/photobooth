export const sampleBackgroundLighting = (imgElement) => {
  const tmp = document.createElement('canvas');
  tmp.width = 32; 
  tmp.height = 32;
  const ctx = tmp.getContext('2d');
  
  // Sample just the center-bottom zone where ambient bounce light comes from
  ctx.drawImage(
    imgElement,
    imgElement.width * 0.25,   // x: 25% in
    imgElement.height * 0.5,   // y: bottom half
    imgElement.width * 0.5,    // w: center 50%
    imgElement.height * 0.5,   // h: bottom half
    0, 0, 32, 32
  );
  
  const { data } = ctx.getImageData(0, 0, 32, 32);

  let r = 0, g = 0, b = 0, lum = 0;
  const count = data.length / 4;

  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }

  r = r / count / 255;
  g = g / count / 255;
  b = b / count / 255;
  lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;

  // Normalize to preserve relative ratios, not crush to grey
  const maxChannel = Math.max(r, g, b) || 1.0; // avoid div by 0
  
  return {
    tint: [r / maxChannel, g / maxChannel, b / maxChannel], // color cast
    luminance: lum, // how bright the scene is
    warmth: r - b,  // positive = warm, negative = cool
  };
};
