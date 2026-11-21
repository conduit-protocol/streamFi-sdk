/**
 * Ambient types for CSS Modules imports.
 *
 * Without this, `import styles from './X.module.css'` is a TS2307 error under
 * `strict` — Vite resolves it at build time but TypeScript has no declaration.
 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
