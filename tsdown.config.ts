/**
 * Standalone build for the ui-cw-textviewer plugin (external bundle living
 * outside the dsh monorepo). Mirrors the semantics of the in-repo
 * `clientBundle` preset (packages/client/tsdown.client.ts) and the
 * ui-cw-fileexplorer sibling plugin:
 *
 * - node half: src/index.ts → lib/index.js (esm, externalizes peer deps);
 * - browser half: src/client/index.ts → lib/client.js (cjs closure factory
 *   handed to window.__ModuleLoader__.load, externals resolved through the
 *   loader module table — the shell-seeded baseline below);
 * - CSS Modules: `x.module.css` compiles through lightningcss into a hashed
 *   class map and injects a plugin-owned style tag at factory execution
 *   (same virtual-id approach as the in-repo preset).
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

/**
 * Shell-seeded module-table entries a browser bundle must never inline
 * (packages/client/web/src/platform.ts: PLATFORM_MODULES +
 * PRELOADED_CLIENT_EXTERNALS). Any non-baseline @deepseek-ai value import
 * would need dsh.client.external; M0 code has none.
 */
const BASELINE_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
] as const

const ID = '@dsh-plugins/ui-cw-textviewer'

/** Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline. */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Emit one plugin-owned style injector plus the CSS Modules class map. */
function styleInjectionModule(
  id: string,
  fileId: string,
  css: string,
  classMap?: Readonly<Record<string, string>>,
): string {
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

/** CSS Modules compilation: hashed class map + minified text + style injector. */
function cssModulesPlugin(id: string) {
  return {
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(this: { addWatchFile(file: string): void }, virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      // The virtual id otherwise hides the physical stylesheet from the watch graph.
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        // Content hash, NOT the path hash: path-hashed names are stable
        // across versions, so a stale HMR-injected stylesheet and the fresh
        // one would share class names and the stale rules win by cascade
        // order (the collapsed-rail centering regression was exactly that).
        cssModules: { pattern: '[content-hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
      return styleInjectionModule(id, fileId, code.toString(), classMap)
    },
  }
}

const nodeConfig: UserConfig = {
  name: ID,
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  // Keep the .js spelling the manifest and exports map name (no .mjs suffix).
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    // Peer dependencies stay imports on the Node side; everything else inlines.
    neverBundle: (specifier: string) => specifier === '@deepseek-ai/cordis',
    alwaysBundle: (specifier: string) => specifier !== '@deepseek-ai/cordis',
  },
}

const clientConfig: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  sourcemap: true,
  deps: {
    neverBundle: (specifier: string) => (BASELINE_EXTERNALS as readonly string[]).includes(specifier),
    alwaysBundle: (specifier: string) => !(BASELINE_EXTERNALS as readonly string[]).includes(specifier),
  },
  // Same substitutions as the in-repo preset: bundled code may read these
  // (zustand/immer read process.env.NODE_ENV; zustand also probes
  // import.meta.env.MODE, which a CJS output cannot carry otherwise).
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  sourcemap: true,
  plugins: [cssModulesPlugin(ID)],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

/**
 * Lazy renderer bundle: Shiki + react-markdown, built separately so the boot
 * client stays light. The host serves the FILE (lib/renderer.js) through the
 * `renderer` endpoint; the client evaluates it on first use as a factory
 * expression `(React, ReactJsxRuntime) => {...}` — the two React modules are
 * the only externals (the shell-seeded table owns them; everything else,
 * including the grammars and the markdown pipeline, is bundled in here).
 */
const RENDERER_EXTERNALS = ['react', 'react/jsx-runtime'] as const

const rendererConfig: UserConfig = {
  name: `${ID}/renderer`,
  entry: { renderer: 'src/client/renderer.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  deps: {
    neverBundle: (specifier: string) => (RENDERER_EXTERNALS as readonly string[]).includes(specifier),
    alwaysBundle: (specifier: string) => !(RENDERER_EXTERNALS as readonly string[]).includes(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  sourcemap: true,
  plugins: [cssModulesPlugin(ID)],
  outputOptions: {
    entryFileNames: 'renderer.js',
    // Standard CJS module output (no custom banner/footer): the loader wraps
    // the source in `new Function('module','exports','require', ...)` and
    // supplies a require shim routing the two React modules to the
    // shell-seeded ones.
  },
}

/**
 * Lazy diagram renderer bundle: the mermaid engine (DOM-only — it can NEVER
 * run inside the highlight worker, which evaluates the renderer bundle with
 * react stubs and no DOM). Built as its own entry and served through the
 * `renderer-diagram` endpoint so:
 *  - renderer.js (shiki + markdown) stays mermaid-free — the worker keeps
 *    fetching/evaluating only what it needs;
 *  - the ~2MB mermaid engine downloads ONLY when a diagram actually renders
 *    (.mmd files, or a ```mermaid fence inside markdown).
 * The bundle's face is a pure render function + one React view; react is an
 * external (shell-seeded instance), everything else is bundled in.
 */
const DIAGRAM_EXTERNALS = ['react', 'react/jsx-runtime'] as const

const diagramConfig: UserConfig = {
  name: `${ID}/renderer-diagram`,
  entry: { rendererDiagram: 'src/client/renderer-diagram.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  deps: {
    neverBundle: (specifier: string) => (DIAGRAM_EXTERNALS as readonly string[]).includes(specifier),
    alwaysBundle: (specifier: string) => !(DIAGRAM_EXTERNALS as readonly string[]).includes(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  sourcemap: true,
  plugins: [cssModulesPlugin(ID)],
  outputOptions: {
    entryFileNames: 'renderer-diagram.js',
    // mermaid lazy-loads its diagram types through internal dynamic
    // import()s — WITHOUT disabling splitting the bundle would split into
    // ~180 CJS chunks, but the host serves ONE file through the RPC endpoint
    // (the loader's require shim cannot resolve relative chunk requires).
    // Inline them all into the single served artifact.
    codeSplitting: false,
  },
}

export default [nodeConfig, clientConfig, rendererConfig, diagramConfig]
