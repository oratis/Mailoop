import { readFile, readdir } from 'node:fs/promises';
import { RequestError } from '../db/database.ts';
const root = new URL('../../skills/', import.meta.url);
export async function installedSkills(name?: string) {
  const folders = (await readdir(root, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && /^[a-z0-9-]+$/.test(d.name))
    .map((d) => d.name)
    .sort();
  if (name && !folders.includes(name)) throw new RequestError(404, 'Unknown skill.');
  if (name) return { name, instructions: await readFile(new URL(name + '/SKILL.md', root), 'utf8') };
  return folders;
}
