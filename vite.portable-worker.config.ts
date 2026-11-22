import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';

export default defineConfig({
  build:{
    ssr:true,
    license:true,
    outDir:'.harbor/portable-build/worker',
    rolldownOptions:{
      input:{journey:'lib/portable-journey-script.ts',landing:'runtime/portable-public-landing.ts',marketing:'runtime/portable-marketing-operator.ts',worker:'runtime/portable-worker.ts',recovery:'runtime/portable-recovery.ts',health:'runtime/portable-health.ts',
        'code-sandbox':'runtime/portable-code-sandbox.ts','google-grant':'runtime/portable-google-grant.ts',
        'prod-server':fileURLToPath(import.meta.resolve('vinext/server/prod-server'))},
      output:{entryFileNames:'[name].mjs'},
    },
  },
});
