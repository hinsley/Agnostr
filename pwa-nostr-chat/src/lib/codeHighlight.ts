import type { HLJSApi, Language, LanguageFn } from 'highlight.js'

const MAX_HIGHLIGHT_CACHE_ENTRIES = 250
const MAX_HIGHLIGHT_CODE_CHARS = 40_000
const MIN_AUTO_RELEVANCE = 5

const PLAIN_TEXT_LANGS = new Set([
  '',
  'text',
  'plain',
  'plaintext',
  'txt',
  'raw',
  'none',
  'nohighlight',
])

const LANG_ALIAS_MAP: Record<string, string> = {
  // JS / TS
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  // Python / Systems
  py: 'python',
  py3: 'python',
  python3: 'python',
  rs: 'rust',
  golang: 'go',
  'c++': 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  h: 'c',
  cs: 'csharp',
  'c#': 'csharp',
  objc: 'objectivec',
  'obj-c': 'objectivec',
  ziglang: 'zig',
  // Shell / Config / Data
  sh: 'bash',
  zsh: 'bash',
  shell: 'bash',
  console: 'bash',
  terminal: 'bash',
  yml: 'yaml',
  toml: 'ini',
  conf: 'ini',
  cfg: 'ini',
  md: 'markdown',
  mdx: 'markdown',
  mk: 'makefile',
  make: 'makefile',
  patch: 'diff',
  gql: 'graphql',
  jsonc: 'json',
  json5: 'json',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  xhtml: 'xml',
  // Proof assistants, Math & FP
  lean: 'lean4',
  lean4: 'lean4',
  lean3: 'lean4',
  tex: 'latex',
  math: 'latex',
  hs: 'haskell',
  ml: 'ocaml',
  mli: 'ocaml',
  rocq: 'coq',
  scm: 'scheme',
  rkt: 'scheme',
  racket: 'scheme',
  el: 'lisp',
  elisp: 'lisp',
  cl: 'lisp',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  jl: 'julia',
  clj: 'clojure',
  cljs: 'clojure',
  edn: 'clojure',
  // JVM / Mobile / Infra / Hardware / Scientific
  kt: 'kotlin',
  kts: 'kotlin',
  rb: 'ruby',
  docker: 'dockerfile',
  proto: 'protobuf',
  ps: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  v: 'verilog',
  sv: 'verilog',
  systemverilog: 'verilog',
  f90: 'fortran',
  f95: 'fortran',
  f03: 'fortran',
  wl: 'mathematica',
  wolfram: 'mathematica',
  viml: 'vim',
  vimscript: 'vim',
}

const EXTRA_LANGUAGE_LOADERS: Record<string, () => Promise<{ default: LanguageFn }>> = {
  haskell: () => import('highlight.js/lib/languages/haskell'),
  ocaml: () => import('highlight.js/lib/languages/ocaml'),
  latex: () => import('highlight.js/lib/languages/latex'),
  nix: () => import('highlight.js/lib/languages/nix'),
  elixir: () => import('highlight.js/lib/languages/elixir'),
  erlang: () => import('highlight.js/lib/languages/erlang'),
  julia: () => import('highlight.js/lib/languages/julia'),
  clojure: () => import('highlight.js/lib/languages/clojure'),
  scala: () => import('highlight.js/lib/languages/scala'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  protobuf: () => import('highlight.js/lib/languages/protobuf'),
  coq: () => import('highlight.js/lib/languages/coq'),
  scheme: () => import('highlight.js/lib/languages/scheme'),
  lisp: () => import('highlight.js/lib/languages/lisp'),
  dart: () => import('highlight.js/lib/languages/dart'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  cmake: () => import('highlight.js/lib/languages/cmake'),
  glsl: () => import('highlight.js/lib/languages/glsl'),
  verilog: () => import('highlight.js/lib/languages/verilog'),
  fortran: () => import('highlight.js/lib/languages/fortran'),
  mathematica: () => import('highlight.js/lib/languages/mathematica'),
  awk: () => import('highlight.js/lib/languages/awk'),
  vim: () => import('highlight.js/lib/languages/vim'),
}

/**
 * First-class Lean 4 + Mathlib syntax grammar (registered as `lean4` with `lean`/`lean3` aliases).
 */
const defineLean4Language: LanguageFn = (hljs: HLJSApi): Language => {
  const NESTED_BLOCK_COMMENT = hljs.COMMENT('/-', '-/', {
    contains: ['self'],
  })

  const DOC_COMMENT = hljs.COMMENT('/-[-!]', '-/', {
    scope: 'comment',
    relevance: 5,
    contains: ['self'],
  })

  const LINE_COMMENT = hljs.COMMENT('--', '$')

  const INTERPOLATED_STRING = {
    scope: 'string',
    begin: /\bs!"/,
    end: /"/,
    contains: [
      hljs.BACKSLASH_ESCAPE,
      {
        scope: 'subst',
        begin: /\{/,
        end: /\}/,
        keywords: {
          keyword: 'let in if then else match with fun do',
          literal: 'true false none some',
        },
      },
    ],
  }

  const CHAR_LITERAL = {
    scope: 'string',
    match: /(?<![A-Za-z0-9_])'(?:\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)|[^'\\\n])'/,
  }

  const HASH_COMMAND = {
    scope: 'meta',
    match: /#(?:check|eval|print|reduce|synth|guard_msgs|guard|where|exit|align|help)\b/,
    relevance: 5,
  }

  const ATTRIBUTE_TAG = {
    scope: 'meta',
    begin: /@\[/,
    end: /\]/,
    relevance: 4,
  }

  const VALUE_DECL = {
    match: [
      /\b(?:theorem|lemma|def|abbrev|axiom|opaque|instance)\b/,
      /\s+/,
      /[A-Za-z_\u0370-\u03FF\u2100-\u214F][A-Za-z0-9_.'\u0370-\u03FF\u2070-\u209F]*/,
    ],
    scope: {
      1: 'keyword',
      3: 'title.function',
    },
    relevance: 4,
  }

  const TYPE_DECL = {
    match: [
      /\b(?:structure|class|inductive|coinductive|namespace)\b/,
      /\s+/,
      /[A-Za-z_\u0370-\u03FF\u2100-\u214F][A-Za-z0-9_.'\u0370-\u03FF\u2070-\u209F]*/,
    ],
    scope: {
      1: 'keyword',
      3: 'title.class',
    },
    relevance: 4,
  }

  const NUMBERS = {
    scope: 'number',
    variants: [
      { match: /\b0[xX][0-9a-fA-F][0-9a-fA-F_]*\b/ },
      { match: /\b0[bB][01][01_]*\b/ },
      { match: /\b0[oO][0-7][0-7_]*\b/ },
      { match: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/ },
    ],
  }

  const UNICODE_MATH_TYPES = {
    scope: 'type',
    match: /[ℕℤℚℝℂ]/,
    relevance: 2,
  }

  const PROOF_OPERATORS = {
    scope: 'operator',
    match: /(?:∀|∃|λ|→|↔|←|↦|≤|≥|≠|∧|∨|¬|⊢|⟨|⟩|∈|∉|⊆|∪|∩|∘|×|:=|=>)/,
    relevance: 2,
  }

  return {
    name: 'Lean 4',
    aliases: ['lean', 'lean4', 'lean3'],
    keywords: {
      keyword: [
        'theorem',
        'lemma',
        'def',
        'abbrev',
        'structure',
        'class',
        'instance',
        'inductive',
        'coinductive',
        'axiom',
        'opaque',
        'example',
        'namespace',
        'end',
        'section',
        'variable',
        'universe',
        'open',
        'import',
        'export',
        'where',
        'let',
        'have',
        'show',
        'from',
        'by',
        'do',
        'match',
        'with',
        'if',
        'then',
        'else',
        'for',
        'in',
        'return',
        'fun',
        'macro',
        'syntax',
        'elab',
        'notation',
        'infix',
        'infixl',
        'infixr',
        'prefix',
        'postfix',
        'attribute',
        'deriving',
        'mutual',
        'partial',
        'unsafe',
        'noncomputable',
        'private',
        'protected',
        'scoped',
        'local',
        'set_option',
        'termination_by',
        'decreasing_by',
        'suffices',
        'nomatch',
        'mut',
      ],
      built_in: [
        'simp',
        'simp_all',
        'rw',
        'rwa',
        'intro',
        'intros',
        'apply',
        'exact',
        'refine',
        'rfl',
        'ring',
        'ring_nf',
        'linarith',
        'nlinarith',
        'omega',
        'aesop',
        'grind',
        'cases',
        'rcases',
        'obtain',
        'induction',
        'constructor',
        'ext',
        'funext',
        'congr',
        'decide',
        'norm_num',
        'norm_cast',
        'positivity',
        'field_simp',
        'push_neg',
        'by_contra',
        'contradiction',
        'trivial',
        'sorry',
        'assumption',
        'use',
        'exists',
        'left',
        'right',
        'split',
        'calc',
        'conv',
        'specialize',
        'generalize',
        'clear',
        'rename_i',
        'revert',
        'subst',
        'injection',
        'change',
        'dsimp',
        'unfold',
        'try',
        'repeat',
        'all_goals',
        'any_goals',
        'first',
        'done',
        'tauto',
        'continuity',
        'measurability',
        'fun_prop',
        'gcongr',
        'abel',
        'exfalso',
      ],
      type: [
        'Type',
        'Prop',
        'Sort',
        'Nat',
        'Int',
        'Rat',
        'Real',
        'Complex',
        'Bool',
        'String',
        'Char',
        'Float',
        'UInt8',
        'UInt16',
        'UInt32',
        'UInt64',
        'USize',
        'Fin',
        'List',
        'Array',
        'Option',
        'Except',
        'IO',
        'Unit',
        'Empty',
        'True',
        'False',
        'Eq',
        'And',
        'Or',
        'Not',
        'Iff',
        'Exists',
        'Sigma',
        'Subtype',
        'Prod',
        'Sum',
        'Set',
        'Finset',
        'Matrix',
      ],
      literal: ['true', 'false', 'none', 'some', 'ok', 'error'],
    },
    contains: [
      DOC_COMMENT,
      NESTED_BLOCK_COMMENT,
      LINE_COMMENT,
      HASH_COMMAND,
      ATTRIBUTE_TAG,
      VALUE_DECL,
      TYPE_DECL,
      INTERPOLATED_STRING,
      hljs.QUOTE_STRING_MODE,
      CHAR_LITERAL,
      NUMBERS,
      UNICODE_MATH_TYPES,
      PROOF_OPERATORS,
    ],
  }
}

/**
 * Compact Zig syntax grammar (not bundled in stock highlight.js).
 */
const defineZigLanguage: LanguageFn = (hljs: HLJSApi): Language => {
  return {
    name: 'Zig',
    aliases: ['ziglang'],
    keywords: {
      keyword: [
        'const',
        'var',
        'fn',
        'pub',
        'return',
        'if',
        'else',
        'while',
        'for',
        'switch',
        'break',
        'continue',
        'defer',
        'errdefer',
        'try',
        'catch',
        'orelse',
        'comptime',
        'inline',
        'noinline',
        'struct',
        'enum',
        'union',
        'error',
        'test',
        'usingnamespace',
        'extern',
        'export',
        'packed',
        'align',
        'volatile',
        'allowzero',
        'threadlocal',
        'and',
        'or',
        'unreachable',
        'async',
        'await',
        'suspend',
        'resume',
        'nosuspend',
        'anytype',
        'anyframe',
      ],
      type: [
        'void',
        'bool',
        'noreturn',
        'type',
        'anyerror',
        'anyopaque',
        'comptime_int',
        'comptime_float',
        'usize',
        'isize',
        'f16',
        'f32',
        'f64',
        'f80',
        'f128',
        'c_char',
        'c_short',
        'c_ushort',
        'c_int',
        'c_uint',
        'c_long',
        'c_ulong',
        'c_longlong',
        'c_ulonglong',
      ],
      literal: ['true', 'false', 'null', 'undefined'],
    },
    contains: [
      hljs.COMMENT('//[/!]?', '$'),
      {
        scope: 'string',
        begin: /\\\\/,
        end: /$/,
      },
      hljs.QUOTE_STRING_MODE,
      {
        scope: 'string',
        match: /'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^'\\\n])'/,
      },
      {
        match: [/\bfn\b/, /\s+/, /[A-Za-z_][A-Za-z0-9_]*/],
        scope: {
          1: 'keyword',
          3: 'title.function',
        },
      },
      {
        scope: 'built_in',
        match: /@[A-Za-z_][A-Za-z0-9_]*/,
        relevance: 4,
      },
      {
        scope: 'type',
        match: /\b[iu](?:[1-9]\d*|0)\b/,
      },
      {
        scope: 'number',
        variants: [
          { match: /\b0[xX][0-9a-fA-F][0-9a-fA-F_]*(?:\.[0-9a-fA-F_]+)?(?:[pP][+-]?\d+)?\b/ },
          { match: /\b0[bB][01][01_]*\b/ },
          { match: /\b0[oO][0-7][0-7_]*\b/ },
          { match: /\b\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?\b/ },
        ],
      },
    ],
  }
}

const highlightCache = new Map<string, string>()
let hljsPromise: Promise<HLJSApi> | null = null
const extraLangPromises = new Map<string, Promise<void>>()

/**
 * Normalizes a fenced code block language tag into a canonical highlight.js language ID.
 */
export function normalizeCodeLang(raw: string): string {
  if (!raw) return ''
  const token = raw.trim().toLowerCase().split(/[\s,;:]/)[0]?.replace(/^\.+/, '') ?? ''
  if (!token) return ''
  return LANG_ALIAS_MAP[token] ?? token
}

function makeCacheKey(normalizedLang: string, code: string): string {
  return `${normalizedLang}\u0000${code}`
}

function writeHighlightCache(key: string, html: string): void {
  if (highlightCache.has(key)) {
    highlightCache.delete(key)
  }
  highlightCache.set(key, html)
  while (highlightCache.size > MAX_HIGHLIGHT_CACHE_ENTRIES) {
    const oldest = highlightCache.keys().next().value
    if (oldest === undefined) break
    highlightCache.delete(oldest)
  }
}

async function loadHighlighter(): Promise<HLJSApi> {
  if (hljsPromise) return hljsPromise
  hljsPromise = import('highlight.js/lib/common')
    .then((mod) => {
      const api = mod.default
      if (!api.getLanguage('lean4')) {
        api.registerLanguage('lean4', defineLean4Language)
      }
      if (!api.getLanguage('zig')) {
        api.registerLanguage('zig', defineZigLanguage)
      }
      return api
    })
    .catch((err) => {
      hljsPromise = null
      throw err
    })
  return hljsPromise
}

async function ensureExtraLanguage(api: HLJSApi, lang: string): Promise<void> {
  if (api.getLanguage(lang)) return
  const loader = EXTRA_LANGUAGE_LOADERS[lang]
  if (!loader) return
  let inflight = extraLangPromises.get(lang)
  if (!inflight) {
    inflight = loader()
      .then((mod) => {
        if (!api.getLanguage(lang)) {
          api.registerLanguage(lang, mod.default)
        }
      })
      .catch(() => {
        extraLangPromises.delete(lang)
      })
    extraLangPromises.set(lang, inflight)
  }
  await inflight
}

/**
 * Synchronously retrieves cached syntax-highlighted HTML for `(lang, code)` if already computed.
 */
export function getCachedHighlightedCode(lang: string, code: string): string | null {
  if (!code || code.length > MAX_HIGHLIGHT_CODE_CHARS) return null
  const normalized = normalizeCodeLang(lang)
  if (PLAIN_TEXT_LANGS.has(normalized)) return null
  const key = makeCacheKey(normalized, code)
  const hit = highlightCache.get(key)
  if (hit === undefined) return null
  // Refresh LRU recency
  highlightCache.delete(key)
  highlightCache.set(key, hit)
  return hit
}

/**
 * Lazily loads `highlight.js` + any requested extra language grammar, highlights `code`
 * into safe HTML (highlight.js escapes all HTML entities), and caches the result in an LRU cache.
 * Returns `null` for empty/plain-text blocks, oversized (>40 KB) pastes, or low-confidence unknown tags.
 */
export async function highlightCodeToHtml(lang: string, code: string): Promise<string | null> {
  if (!code || code.length > MAX_HIGHLIGHT_CODE_CHARS) return null
  const normalized = normalizeCodeLang(lang)
  if (PLAIN_TEXT_LANGS.has(normalized)) return null

  const key = makeCacheKey(normalized, code)
  const cached = highlightCache.get(key)
  if (cached !== undefined) {
    highlightCache.delete(key)
    highlightCache.set(key, cached)
    return cached
  }

  const api = await loadHighlighter()
  if (normalized in EXTRA_LANGUAGE_LOADERS) {
    await ensureExtraLanguage(api, normalized)
  }

  let html: string | null = null
  if (api.getLanguage(normalized)) {
    const result = api.highlight(code, { language: normalized, ignoreIllegals: true })
    html = result.value || null
  } else {
    const auto = api.highlightAuto(code)
    if (auto.relevance >= MIN_AUTO_RELEVANCE && auto.value) {
      html = auto.value
    }
  }

  if (html) {
    writeHighlightCache(key, html)
  }
  return html
}
