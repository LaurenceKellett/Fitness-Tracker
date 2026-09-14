/* Lint config.
 *
 * Deliberately not a style guide. The repo has a voice and a shape already, and a
 * linter that argues about quotes and semicolons in a 400KB single-page app is a
 * thousand-line diff that hides the one finding worth having. What is switched on
 * here is the set of rules that catch things which are wrong rather than merely
 * different: a name that does not exist, a variable nobody reads, a `case` that
 * falls into the next one, a promise nobody waits for.
 *
 * `no-unused-vars` is the one that pays for the whole file. A dead
 * `const row = document.getElementById(...)` sat in renderRaceChart for months.
 */
import globals from 'globals';

export default [
  {
    // app.js is the dashboard's own script, extracted out of index.html. It shares
    // one global lexical scope with calc.js, which is why so much of it reads as
    // undeclared — calc.js declares it.
    files: ['app.js', 'calc.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        Chart: 'readonly',
        L: 'readonly',
        module: 'writable',
      },
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      // vars:'local' rather than the default. The top level of app.js and calc.js IS
      // the page's global scope: they share it with each other and with the markup,
      // so a function declared here and called from an onclick attribute or from the
      // other file is used, and ESLint cannot see either. Checking locals still
      // catches the thing worth catching — a dead binding inside a function, which
      // is where the two it found on its first run were.
      'no-unused-vars': ['error', {
        vars: 'local',
        args: 'none',                 // handlers routinely ignore their event
        varsIgnorePattern: '^_',
        caughtErrors: 'none',         // `catch(e){}` is a deliberate idiom here
        ignoreRestSiblings: true,     // `const {polylines, ...rest} = a` is an omit
      }],
      // calc.js and app.js share a global scope on purpose, so cross-file
      // references are correct and no-undef cannot see them. Globals are listed
      // above; anything else genuinely is a typo.
      'no-undef': 'off',
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-fallthrough': 'error',
      'no-self-compare': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-cond-assign': ['error', 'always'],
      'no-sparse-arrays': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-async-promise-executor': 'error',
      'require-atomic-updates': 'error',
      'no-compare-neg-zero': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-template-curly-in-string': 'warn',
      eqeqeq: ['warn', 'smart'],
    },
  },
  {
    files: ['worker.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.worker, ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-fallthrough': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-async-promise-executor': 'error',
      eqeqeq: ['warn', 'smart'],
    },
  },
  {
    files: ['sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.serviceworker },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-undef': 'error',
    },
  },
  {
    files: ['test/**/*.{js,mjs}', 'eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-undef': 'off',   // vitest globals and in-page evaluate() bodies
    },
  },
];
