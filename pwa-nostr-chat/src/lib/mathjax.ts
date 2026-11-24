const MAX_MATH_CACHE_ENTRIES = 400

const SAFE_TEX_PACKAGES: readonly string[] = [
  'base',
  'ams',
  'newcommand',
  'boldsymbol',
  'cancel',
  'color',
  'mathtools',
  'textmacros',
  'braket',
  'unicode',
  'noerrors',
  'noundefined',
]

// Currency-safe inline math pattern: opening `$` not preceded by `\` and not followed by whitespace;
// closing `$` not preceded by `\` or whitespace and not immediately followed by a digit.
const INLINE_DOLLAR_RE = /(^|[^\\$])\$(?!\s)(?:\\.|[^$\\])+?(?<!\s|\\)\$(?![\d$])/

interface MathJaxConverter {
  convertToSvg: (tex: string, display: boolean) => string
}

const mathSvgCache = new Map<string, string>()
let converterPromise: Promise<MathJaxConverter> | null = null

function makeCacheKey(tex: string, display: boolean): string {
  return `${display ? 'D' : 'I'}:${tex.trim()}`
}

function writeCache(key: string, svg: string): void {
  if (mathSvgCache.has(key)) {
    mathSvgCache.delete(key)
  }
  mathSvgCache.set(key, svg)
  while (mathSvgCache.size > MAX_MATH_CACHE_ENTRIES) {
    const oldestKey = mathSvgCache.keys().next().value
    if (oldestKey === undefined) break
    mathSvgCache.delete(oldestKey)
  }
}

/**
 * Defense-in-depth sanitizer on MathJax-generated SVG markup.
 * Strips any script/foreignObject/embed/link elements, inline event handlers,
 * `href`/`xlink:href`, or `javascript:` URIs before returning standalone `<svg>`.
 */
function sanitizeMathSvg(rawHtml: string): string {
  const svgMatch = rawHtml.match(/<svg[\s\S]*?<\/svg>/i)
  if (!svgMatch) return ''
  let svg = svgMatch[0]
  svg = svg.replace(/<(script|foreignObject|iframe|object|embed|style|a)\b[\s\S]*?<\/\1>/gi, '')
  svg = svg.replace(/<(script|foreignObject|iframe|object|embed|style|a)\b[^>]*\/?>/gi, '')
  svg = svg.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  svg = svg.replace(/\s+(?:xlink:)?href\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  svg = svg.replace(/javascript\s*:/gi, '')
  return svg
}

async function getMathJaxConverter(): Promise<MathJaxConverter> {
  if (converterPromise) return converterPromise
  converterPromise = (async () => {
    const [
      { mathjax },
      { TeX },
      { SVG },
      { liteAdaptor },
      { RegisterHTMLHandler },
    ] = await Promise.all([
      import('mathjax-full/js/mathjax.js'),
      import('mathjax-full/js/input/tex.js'),
      import('mathjax-full/js/output/svg.js'),
      import('mathjax-full/js/adaptors/liteAdaptor.js'),
      import('mathjax-full/js/handlers/html.js'),
      // Register safe Markdown/LaTeX TeX packages ONLY (explicitly excluding html/action/require)
      import('mathjax-full/js/input/tex/base/BaseConfiguration.js'),
      import('mathjax-full/js/input/tex/ams/AmsConfiguration.js'),
      import('mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js'),
      import('mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration.js'),
      import('mathjax-full/js/input/tex/cancel/CancelConfiguration.js'),
      import('mathjax-full/js/input/tex/color/ColorConfiguration.js'),
      import('mathjax-full/js/input/tex/mathtools/MathtoolsConfiguration.js'),
      import('mathjax-full/js/input/tex/textmacros/TextMacrosConfiguration.js'),
      import('mathjax-full/js/input/tex/braket/BraketConfiguration.js'),
      import('mathjax-full/js/input/tex/unicode/UnicodeConfiguration.js'),
      import('mathjax-full/js/input/tex/noerrors/NoErrorsConfiguration.js'),
      import('mathjax-full/js/input/tex/noundefined/NoUndefinedConfiguration.js'),
    ])

    const adaptor = liteAdaptor()
    RegisterHTMLHandler(adaptor)

    const texInput = new TeX({
      packages: [...SAFE_TEX_PACKAGES],
      maxMacros: 1000,
      maxBuffer: 10 * 1024,
    })

    const svgOutput = new SVG({
      fontCache: 'none',
    })

    const doc = mathjax.document('', {
      InputJax: texInput,
      OutputJax: svgOutput,
    })

    return {
      convertToSvg(tex: string, display: boolean): string {
        const node = doc.convert(tex, { display })
        const raw = adaptor.innerHTML(node)
        return sanitizeMathSvg(raw)
      },
    }
  })().catch((err) => {
    converterPromise = null
    throw err
  })

  return converterPromise
}

/**
 * Fast pre-check determining whether a message might contain LaTeX math syntax
 * (`$$...$$`, `\\[...\\]`, `\\(...\\)`, or currency-safe inline `$...$`).
 */
export function hasMathSyntax(text: string): boolean {
  if (!text) return false
  if (text.includes('$$')) return true
  if (text.includes('\\[') && text.includes('\\]')) return true
  if (text.includes('\\(') && text.includes('\\)')) return true
  if (text.includes('$') && INLINE_DOLLAR_RE.test(text)) return true
  return false
}

/**
 * Synchronously retrieves a cached SVG for `(tex, display)` if already rendered.
 */
export function getCachedMathSvg(tex: string, display: boolean): string | null {
  const key = makeCacheKey(tex, display)
  const hit = mathSvgCache.get(key)
  if (hit === undefined) return null
  // Refresh LRU recency
  mathSvgCache.delete(key)
  mathSvgCache.set(key, hit)
  return hit
}

/**
 * Lazily loads offline MathJax SVG engine on first call, renders `tex` into self-contained
 * sanitized `<svg>` markup (inheriting `currentColor`), and caches the result in an LRU cache.
 */
export async function renderMathToSvg(tex: string, display: boolean): Promise<string> {
  const trimmed = tex.trim()
  if (!trimmed) return ''
  const key = makeCacheKey(trimmed, display)
  const cached = getCachedMathSvg(trimmed, display)
  if (cached !== null) return cached

  const converter = await getMathJaxConverter()
  const svg = converter.convertToSvg(trimmed, display)
  if (svg) {
    writeCache(key, svg)
  }
  return svg
}
