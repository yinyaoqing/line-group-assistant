// Vite/Vitest "?raw" imports return the file's text.
declare module "*?raw" {
  const content: string;
  export default content;
}
