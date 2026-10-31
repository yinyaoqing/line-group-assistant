// Wrangler bundles .png files as binary data (see [[rules]] in wrangler.toml).
declare module "*.png" {
  const content: ArrayBuffer;
  export default content;
}
