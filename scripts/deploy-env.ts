import { readFileSync } from 'node:fs';

/** Read the literal values written by deploy.sh, including older unquoted files. */
export function readDeploymentEnvironment(filename: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(filename, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('=');
        if (separator < 1) throw new Error('Invalid deployment environment entry');
        const key = line.slice(0, separator);
        const value = line.slice(separator + 1);
        return [key, value.startsWith('"') ? (JSON.parse(value) as string).replace(/\$\$/g, '$') : value];
      }),
  );
}
