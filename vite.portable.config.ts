import {defineConfig} from 'vite';
import vinext from 'vinext';
import {fileURLToPath} from 'node:url';

const output='.harbor/portable-build';
export default defineConfig({
  build:{license:true},
  plugins:vinext({rscOutDir:output+'/server',ssrOutDir:output+'/server/ssr'})
    .filter(plugin=>!(plugin&&typeof plugin==='object'&&'name' in plugin&&plugin.name==='vinext:build-id')),
  environments:{client:{build:{outDir:output+'/client'}}},
  resolve:{alias:{'cloudflare:workers':fileURLToPath(new URL('./runtime/portable-env.ts',import.meta.url))}},
});
