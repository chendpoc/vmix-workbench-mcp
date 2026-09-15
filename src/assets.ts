import path from 'node:path';
import { realpath, mkdir, stat, copyFile, rename, unlink, constants } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { Fault } from './vmix.js';

const inside = (root: string, child: string) => {
  const r = path.relative(root, child);
  return r === '' || (!r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r));
};
export function validateMediaPath(value: string) {
  if ((!path.isAbsolute(value) && !path.win32.isAbsolute(value)) || /[\r\n\0|]/.test(value))
    throw new Fault(
      'ASSET_PATH',
      'Use an absolute path visible to vMix, without control characters or |',
    );
}
export class Assets {
  constructor(private config: Config) {}
  async stage(source: string, dryRun: boolean) {
    const src = await realpath(source);
    const roots = await Promise.all(this.config.sourceRoots.map((r) => realpath(r)));
    if (!roots.some((r) => inside(r, src)))
      throw new Fault('ASSET_ROOT', 'Source resolves outside VMIX_SOURCE_ROOTS');
    const metadata = await stat(src);
    if (!metadata.isFile()) throw new Fault('ASSET_TYPE', 'Stage one regular file at a time');
    const ext = path.extname(src).toLowerCase();
    if (!/^\.(mp4|mov|avi|mkv|webm|wmv|png|jpg|jpeg|bmp|gif|gtzip|wav|mp3|m4a|flac)$/.test(ext))
      throw new Fault('ASSET_TYPE', 'Unsupported media extension; title packages use .gtzip');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(src)) hash.update(chunk);
    const sha256 = hash.digest('hex');
    const filename = `${sha256}${ext}`;
    const visible = /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(this.config.vmixAssetRoot)
      ? path.win32.join(this.config.vmixAssetRoot, filename)
      : path.join(this.config.vmixAssetRoot, filename);
    validateMediaPath(visible);
    if (!dryRun) {
      await mkdir(this.config.assetRoot, { recursive: true });
      const root = await realpath(this.config.assetRoot);
      const dest = path.join(root, filename);
      const temp = path.join(root, `${randomUUID()}.tmp`);
      await copyFile(src, temp, constants.COPYFILE_EXCL);
      // Hash the actual copied bytes: detect source changes during hashing/copy.
      const copied = createHash('sha256');
      for await (const chunk of createReadStream(temp)) copied.update(chunk);
      if (copied.digest('hex') !== sha256) {
        await unlink(temp);
        throw new Fault('ASSET_CHANGED', 'Source changed during staging; retry with a stable file');
      }
      await rename(temp, dest);
    }
    return {
      dry_run: dryRun,
      sha256,
      bytes: metadata.size,
      vmix_path: visible,
      mapping_required: this.config.assetRoot !== this.config.vmixAssetRoot,
      note: 'vMix must see the same bytes at vmix_path. This does not upload to an unmapped remote Windows directory.',
    };
  }
}
