import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

register('./local-origin-loader.mjs', import.meta.url);

const preloadPath = fileURLToPath(import.meta.url);
const preloadFlag = `--import=${pathToFileURL(preloadPath).href}`;
if (!String(process.env.NODE_OPTIONS || '').includes(preloadPath)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} ${preloadFlag}`.trim();
}
