export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const injectedOrigin = process.env.FINCHIP_API_URL?.trim();
  if (!injectedOrigin || result.format !== 'module') return result;
  if (url.endsWith('/src/localhost-confirmation.js')) {
    return {
      ...result,
      source: String(result.source).replace('try { openBrowser(localUrl); }', 'try { /* repository test: do not launch a real browser */ }'),
      shortCircuit: true,
    };
  }
  if (!url.endsWith('/src/site-origin.js')) return result;
  const normalized = new URL(injectedOrigin).origin;
  const source = String(result.source)
    .replace(
      "export const FINCHIP_PROD_ORIGIN = 'https://finchip.ai';",
      `export const FINCHIP_PROD_ORIGIN = ${JSON.stringify(normalized)};\ndelete process.env.FINCHIP_API_URL;`,
    )
    .replace("url.origin !== FINCHIP_PROD_ORIGIN || url.protocol !== 'https:'", "url.origin !== FINCHIP_PROD_ORIGIN")
    .replace(' || url.port)', ')');
  return { ...result, source, shortCircuit: true };
}
