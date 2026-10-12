// Vite's ?inline suffix imports a stylesheet as a string.
declare module '*.css?inline' {
  const css: string;
  export default css;
}
