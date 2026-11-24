import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { RequestError } from '../db/database.ts';
const root = new URL('../../skills/', import.meta.url);
export async function installedSkills(name?: string) {
  const folders = (await readdir(root, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && /^[a-z0-9-]+$/.test(d.name))
    .map((d) => d.name)
    .sort();
  if (name && !folders.includes(name)) throw new RequestError(404, 'Unknown skill.');
  const manifests = JSON.parse(await readFile(new URL('registry.json', root), 'utf8'));
  const entries = await Promise.all(
    (name ? [name] : folders).map(async (id) => {
      const instructions = await readFile(new URL(id + '/SKILL.md', root), 'utf8'),
        contract = manifests[id];
      if (!contract) throw new RequestError(500, 'Skill contract is missing.');
      const version = createHash('sha256')
        .update(instructions)
        .update(JSON.stringify(contract))
        .digest('hex');
      return { name: id, version, ...contract, ...(name && { instructions }) };
    })
  );
  return name ? entries[0] : entries;
}
