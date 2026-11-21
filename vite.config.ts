import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const supabaseUrl = (env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim();
  const supabasePublicKey = (
    env.VITE_SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    ''
  ).trim();

  return {
    // Only expose browser-safe VITE_* variables; never bundle server secrets or service_role keys
    envPrefix: 'VITE_',
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'validate-supabase-build-env',
        apply: 'build',
        buildStart(): void {
          const missing: string[] = [];
          if (!supabaseUrl) missing.push('VITE_SUPABASE_URL');
          if (!supabasePublicKey) {
            missing.push('VITE_SUPABASE_ANON_KEY (or VITE_SUPABASE_PUBLISHABLE_KEY)');
          }
          if (missing.length > 0) {
            this.warn(
              `Missing build-time Supabase environment variable(s): ${missing.join(', ')}. ` +
                'Vite inlines VITE_* variables during `npm run build`. Configure these as build-time environment variables and rebuild to enable live Supabase authentication.'
            );
          }
        },
      },
      // Copies src/assets into dist/ so root-relative URLs like
      // "/src/assets/images/..." (e.g. generate_image output) still resolve
      // in production builds. Do not remove.
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          const srcAssets = path.resolve(__dirname, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, {recursive: true, force: true});
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
