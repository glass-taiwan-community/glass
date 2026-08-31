import js from '@eslint/js';
import globals from 'globals';

/**
 * Flat config for the Electron app. Two other packages lint themselves and are excluded here:
 * `pickleglass_web` (Next.js, own .eslintrc.json) and `functions` (Firebase, own .eslintrc.js).
 *
 * The repo mixes module systems on purpose - the main process is CommonJS and the renderer is
 * ESM bundled by esbuild - so sourceType is set per directory rather than globally. Getting this
 * wrong makes ESLint report parse errors that look like real defects, which is the failure this
 * config exists to prevent.
 */
/**
 * Pre-existing violations inherited from upstream, recorded here rather than silenced.
 *
 * These are cleanup-category rules, not correctness ones: leaving them at `error` would keep
 * `npm run lint` permanently red, and a permanently red lint is one nobody reads - which is how
 * this repo ended up with a lint command that had never run at all. As `warn` the command stays
 * green, the debt stays visible, and any NEW correctness violation is an error that fails loudly.
 *
 * Counts at the time of baselining (2026-08-31). Lower these to `error` as they reach zero.
 */
const BASELINED = {
    'no-unused-vars': 'warn',      // 137
    'no-case-declarations': 'warn', // 11
    'no-empty': 'warn',             // 5
    'no-useless-catch': 'warn',     // 5
};

export default [
    {
        ignores: [
            'node_modules/**',
            'public/build/**',
            'out/**',
            'dist/**',
            'test-results/**',
            'playwright-report/**',
            'pickleglass_web/**',
            'functions/**',
            // Vendored minified libraries - not ours to lint.
            'src/ui/assets/**',
            // Emscripten-generated WASM glue for the acoustic echo canceller. Machine output,
            // 200KB+ on one line; linting it produced a third of the repo's total findings and
            // none of them were actionable.
            'src/ui/listen/audioCore/aec.js',
        ],
    },

    // Main process and build tooling: CommonJS on Node.
    {
        files: ['src/**/*.js', 'build.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
        rules: { ...js.configs.recommended.rules, ...BASELINED },
    },

    // Renderer: ESM in the browser, bundled by esbuild.
    {
        files: ['src/ui/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.browser },
        },
    },

    // Preload straddles both worlds by design.
    {
        files: ['src/preload.js'],
        languageOptions: {
            sourceType: 'commonjs',
            globals: { ...globals.node, ...globals.browser },
        },
    },

    // Playwright's own config is ESM, unlike the CommonJS main process.
    {
        files: ['playwright.config.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.node },
        },
        rules: { ...js.configs.recommended.rules },
    },

    // Tests: ESM on Node. Browser globals are included because page.evaluate() callbacks are
    // written inline here but execute in the renderer, where document and customElements exist.
    {
        files: ['tests/**/*.{js,mjs}'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.node, ...globals.browser },
        },
        rules: { ...js.configs.recommended.rules, ...BASELINED },
    },
];
