import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit()
	],
	build: {
		rollupOptions: {
			output: {
				manualChunks(id) {
					if (!id.includes('node_modules')) return;
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
			allow: ['..']
		},
		proxy: {
			'/api': {
				target: 'http://localhost:3721',
				changeOrigin: true
			}
		}
	}
});
