// Wrangler bundles .html files as text (see [[rules]] in wrangler.toml).
declare module "*.html" {
  const content: string;
  export default content;
}
