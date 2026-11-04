import { promises as fsp } from 'node:fs';

/** Minimal file system access used by the provider (replaceable in tests). */
export interface FileSystem {
  /**
   * Reads a UTF-8 text file.
   * @param path Absolute file path.
   * @returns The contents, or undefined when the file does not exist.
   */
  readFile(path: string): Promise<string | undefined>;
  /**
   * Lists the entry names of a directory.
   * @param dir Absolute directory path.
   * @returns Entry names; empty when the directory does not exist.
   */
  listDir(dir: string): Promise<string[]>;
}

/** Tells whether an error is a Node "not found / not a file" error. */
function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR';
}

/** {@link FileSystem} backed by Node's `fs`. Missing files/directories are not errors; other errors propagate. */
export const nodeFileSystem: FileSystem = {
  async readFile(path: string): Promise<string | undefined> {
    try {
      return await fsp.readFile(path, 'utf8');
    } catch (err) {
      if (isMissing(err)) {
        return undefined;
      }
      throw err;
    }
  },
  async listDir(dir: string): Promise<string[]> {
    try {
      return await fsp.readdir(dir);
    } catch (err) {
      if (isMissing(err)) {
        return [];
      }
      throw err;
    }
  },
};
