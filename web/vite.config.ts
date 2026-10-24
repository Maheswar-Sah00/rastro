import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Lists which data files exist (real vs mock) so the app never requests a
// missing file. Served live in dev, emitted as data/_files.json at build time.
function dataManifest(): Plugin {
  const root = path.resolve(__dirname, 'public/data');
  const scan = () => {
    const list = (dir: string, prefix = ''): string[] => {
      if (!fs.existsSync(dir)) return [];
      const out: string[] = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix + e.name;
        if (e.isDirectory()) {
          if (rel === 'mock' || rel === 'evidence') continue;
          out.push(...list(path.join(dir, e.name), rel + '/'));
        } else if (/\.(geo)?json$/i.test(e.name) && e.name !== '_files.json') out.push(rel);
      }
      return out;
    };
    const hasDir = (d: string) => fs.existsSync(d) && fs.readdirSync(d).some((f) => f.endsWith('.json'));
    const mockDir = path.join(root, 'mock');
    return {
      generated_at: new Date().toISOString(),
      real: list(root),
      mock: list(mockDir).filter((f) => !f.startsWith('evidence/')),
      evidence: { real: hasDir(path.join(root, 'evidence')), mock: hasDir(path.join(mockDir, 'evidence')) },
    };
  };
  return {
    name: 'rastro-data-manifest',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.split('?')[0].endsWith('/data/_files.json')) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(scan()));
          return;
        }
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        // In preview, prefer the emitted file but fall back to a live scan.
        if (req.url && req.url.split('?')[0].endsWith('/data/_files.json') && !fs.existsSync(path.resolve(__dirname, 'dist/data/_files.json'))) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(scan()));
          return;
        }
        next();
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'data/_files.json', source: JSON.stringify(scan()) });
    },
  };
}

// Base path is configurable for GitHub Pages: VITE_BASE=/rastro/ npm run build
// (default './' works from any sub-path because the app uses hash routing).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  let base = env.VITE_BASE || process.env.VITE_BASE || './';
  if (base !== './' && !base.endsWith('/')) base += '/';
  return {
    base,
    plugins: [react(), dataManifest()],
    // Inline (empty) PostCSS config: stops Vite from picking up a config file from a parent folder.
    css: { postcss: { plugins: [] } },
    build: {
      target: 'es2020',
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        // Two pages: the judge-facing site (index.html) and the analyst console (console.html).
        input: { main: path.resolve(__dirname, 'index.html'), console: path.resolve(__dirname, 'console.html') },
        output: {
          manualChunks: (id) => {
            if (id.includes('node_modules/maplibre-gl')) return 'maplibre';
            if (id.includes('node_modules/d3-')) return 'd3';
            return undefined;
          },
        },
      },
    },
  };
});
