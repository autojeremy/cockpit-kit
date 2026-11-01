// Lint helper: literal colors in a page's <style> blocks.
// Pages should use the theme tokens from cockpit.css (--ink, --surface, --rule,
// --ok/--warn/--bad/--info and their -bg/-rule pairs) so light and dark both work.
// Allowed: @media print blocks (paper is always white), and custom-property
// definitions (--x: #hex) when the same page also defines a dark variant.

const COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|\b(?:white|black)\b/i;
const DARK = /data-theme\s*=\s*["']?dark|prefers-color-scheme\s*:\s*dark/i;

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

// Remove every `@media print { ... }` block (brace-matched).
export function stripPrintMedia(css) {
  let out = '';
  let i = 0;
  const re = /@media\s+print\b[^{]*\{/gi;
  let m;
  while ((m = re.exec(css))) {
    out += css.slice(i, m.index);
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') depth -= 1;
      j += 1;
    }
    i = j;
    re.lastIndex = j;
  }
  return out + css.slice(i);
}

export function hardcodedColorFindings(css) {
  const clean = stripPrintMedia(stripComments(css));
  const hasDark = DARK.test(clean);
  const out = [];
  const seen = new Set();
  const blocks = /\{([^{}]*)\}/g;
  let b;
  while ((b = blocks.exec(clean))) {
    for (const decl of b[1].split(';')) {
      const at = decl.indexOf(':');
      if (at < 0) continue;
      const prop = decl.slice(0, at).trim();
      const value = decl.slice(at + 1).replace(/url\([^)]*\)/gi, ' ').trim();
      if (!prop || !COLOR.test(value)) continue;
      if (prop.startsWith('--') && hasDark) continue;
      const key = `${prop}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const hint = prop.startsWith('--')
        ? 'define a dark-theme value too, or use the shared tokens'
        : 'use a theme token such as var(--ink), var(--surface), var(--rule) or var(--ok|--warn|--bad|--info)';
      out.push({ code: 'hardcoded-color', message: `Literal color in <style>: ${prop}: ${value} (${hint}; @media print is exempt)` });
    }
  }
  return out;
}
