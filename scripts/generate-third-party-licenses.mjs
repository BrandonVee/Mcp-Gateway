import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Shared source is imported through aliases, so its dependencies are bundled too.
const licenses = JSON.parse(
  execFileSync(
    'pnpm',
    ['--filter', '@mcp/admin-web', '--filter', '@mcp/shared', 'licenses', 'list', '--prod', '--json'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    },
  ),
);
const packages = new Map();
for (const entry of Object.values(licenses).flat()) {
  for (const path of entry.paths) {
    const metadata = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
    packages.set(`${metadata.name}@${metadata.version}`, { path, metadata });
  }
}
if (!packages.size) throw new Error('No installed frontend dependencies found; run pnpm install first.');

async function readNotices(directory, packageRoot = directory, includeAll = false) {
  const documents = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!includeAll && !/^(licen[sc]e|copying|notice|copyright)/i.test(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) documents.push(...(await readNotices(path, packageRoot, true)));
    else if (entry.isFile()) {
      documents.push({ name: relative(packageRoot, path), text: (await readFile(path, 'utf8')).trim() });
    }
  }
  return documents;
}

const sections = [
  'MCP Gateway — frontend third-party licenses',
  'Generated from the installed production dependencies of @mcp/admin-web and @mcp/shared.',
  'The inventory includes their dependency closure; some modules may be removed by tree shaking.',
  'These dependencies retain their own licenses. Project and font notices are distributed separately.',
];
for (const [id, { path, metadata }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const documents = await readNotices(path);
  if (!documents.some(({ name }) => /^(licen[sc]e|copying)/i.test(name))) {
    // This package publishes its complete MIT license in the README instead.
    if (metadata.name === 'is-mobile' && metadata.version === '5.0.0') {
      const readme = await readFile(join(path, 'README.md'), 'utf8');
      const license = readme.match(/(?:^|\n)## License[ \t]*\r?\n([\s\S]*?)(?=\r?\n## |$)/)?.[1];
      if (license?.includes('Permission is hereby granted'))
        documents.push({ name: 'README.md — License', text: license.trim() });
    }
    // icons-svg omits LICENSE from its npm tarball. The verified monorepo root
    // license is also shipped by its React adapter; do not invent a copyright.
    // https://github.com/ant-design/ant-design-icons/blob/master/LICENSE
    if (metadata.name === '@ant-design/icons-svg' && metadata.version === '4.6.0') {
      const adapter = [...packages.values()].find(({ metadata }) => metadata.name === '@ant-design/icons');
      if (adapter) {
        documents.push({
          name: 'LICENSE — ant-design-icons monorepo root (from @ant-design/icons)',
          text: (await readFile(join(adapter.path, 'LICENSE'), 'utf8')).trim(),
        });
      }
    }
    if (!documents.some(({ name }) => /^(licen[sc]e|copying|README.md — License)/i.test(name))) {
      throw new Error(`Missing full license text for ${id}; review its upstream license before distributing it.`);
    }
  }
  if (documents.some(({ text }) => !text)) throw new Error(`Empty license or notice for ${id}.`);
  const license = typeof metadata.license === 'string' ? metadata.license : metadata.license?.type;
  sections.push(
    '='.repeat(80),
    id,
    `Declared license: ${license ?? 'See included license text'}`,
    ...documents.map(({ name, text }) => `--- ${name} ---\n${text}`),
  );
}

const output = join(root, 'packages/admin-web/dist/THIRD_PARTY_LICENSES.txt');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, sections.join('\n\n') + '\n');
console.log(`Wrote frontend license and notice texts for ${packages.size} packages.`);
