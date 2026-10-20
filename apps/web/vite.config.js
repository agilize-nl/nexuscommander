import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit()
	],
	// @nexus/ui is a symlinked workspace package under active development, not a
	// real external dependency. Vite's dep optimizer pre-bundles and caches it
	// like any node_modules package and does not reliably invalidate that cache
	// when its source changes, so edits (e.g. to i18n/locales) can silently keep
	// serving a stale snapshot. Excluding it forces Vite to always serve its
	// live source.
	optimizeDeps: {
		exclude: ['@nexus/ui']
	},
	build: {
		rollupOptions: {
			output: {
				manualChunks(id) {
					if (!id.includes('node_modules')) return;
					// FileEditor imports language parsers dynamically. Leave their
					// wrappers and Lezer grammars in Rollup's natural lazy graph so
					// selecting one language does not download every parser.
					if (id.includes('/@codemirror/lang-') || id.includes('/@lezer/')) return;
					if (id.includes('/@codemirror/') || id.includes('/codemirror/')) return 'vendor-codemirror';
					if (id.includes('/lucide-svelte/')) return 'vendor-icons';
					if (id.includes('/@sveltejs/') || id.includes('/svelte/')) return 'vendor-svelte';
					return 'vendor';
				}
			}
		}
	},
	server: {
		host: '0.0.0.0',
		fs: {
			allow: [searchForWorkspaceRoot(process.cwd())]
		},
		proxy: {
			'/api': {
				target: 'http://localhost:3721',
				changeOrigin: true
			}
		}
	}
});
