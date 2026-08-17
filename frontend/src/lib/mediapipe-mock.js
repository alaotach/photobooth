// This mock intercepts Vite's bundling of the broken MediaPipe NPM package
// and instead provides the globally loaded script from the CDN, which correctly loads the WASM.
export const SelfieSegmentation = window.SelfieSegmentation;
