import path from 'node:path';
import { z } from 'zod';

export interface Config {
  apiUrl: string;
  timeoutMs: number;
  pollMs: number;
  dataDir: string;
  sourceRoots: string[];
  assetRoot: string;
  vmixAssetRoot: string;
  readOnly: boolean;
  authorization?: string;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const url = new URL(env.VMIX_API_URL ?? 'http://127.0.0.1:8088/api/');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('VMIX_API_URL must be an HTTP(S) API URL without credentials/query/fragment');
  const dataDir = path.resolve(env.VMIX_DATA_DIR ?? '.vmix-mcp');
  const assetRoot = path.resolve(env.VMIX_ASSET_ROOT ?? path.join(dataDir, 'assets'));
  const roots = z
    .array(z.string().min(1))
    .min(1)
    .parse(env.VMIX_SOURCE_ROOTS ? JSON.parse(env.VMIX_SOURCE_ROOTS) : [process.cwd()]);
  const readOnly = z.enum(['true', 'false']).parse(env.VMIX_READ_ONLY ?? 'false') === 'true';
  return {
    apiUrl: url.toString(),
    dataDir,
    assetRoot,
    vmixAssetRoot: env.VMIX_VISIBLE_ASSET_ROOT ?? assetRoot,
    sourceRoots: roots.map((r) => path.resolve(r)),
    readOnly,
    timeoutMs: z.coerce
      .number()
      .int()
      .min(100)
      .max(60000)
      .parse(env.VMIX_TIMEOUT_MS ?? 5000),
    pollMs: z.coerce
      .number()
      .int()
      .min(100)
      .max(10000)
      .parse(env.VMIX_POLL_MS ?? 250),
    authorization:
      env.VMIX_API_USERNAME !== undefined
        ? `Basic ${Buffer.from(`${env.VMIX_API_USERNAME}:${env.VMIX_API_PASSWORD ?? ''}`).toString('base64')}`
        : undefined,
  };
}
