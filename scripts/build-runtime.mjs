import { build } from 'esbuild';
import { resolve } from 'node:path';

// @mcp/shared is inlined into each bundle while every other package stays
// external, so a runtime dependency added to packages/shared must also be
// declared by auth-server and gateway: the images only install their own.
const shared = resolve('packages/shared/src/index.ts');
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  minify: false,
  plugins: [
    {
      name: 'bundle-workspace-shared',
      setup(plugin) {
        plugin.onResolve({ filter: /^@mcp\/shared$/ }, () => ({ path: shared }));
      },
    },
  ],
};

for (const service of ['auth-server', 'gateway']) {
  await build({
    ...common,
    entryPoints: [`packages/${service}/src/index.ts`],
    outfile: `packages/${service}/dist/index.js`,
  });
}
