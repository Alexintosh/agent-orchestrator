import { promises as fs } from "node:fs";
import path from "node:path";

const SKILL_ROOT_RELATIVE_CANDIDATES = [
  "../../skills",
  "../../../../../skills",
];

export interface SkillEntry {
  name: string;
  source: string;
}

function normalizePathSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}

function isMaintainerOnlySkillTarget(candidate: string): boolean {
  return normalizePathSlashes(candidate).includes("/.agents/skills/");
}

export async function resolveSkillsDir(
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<string | null> {
  const candidates = [
    ...SKILL_ROOT_RELATIVE_CANDIDATES.map((relativePath) =>
      path.resolve(moduleDir, relativePath),
    ),
    ...additionalCandidates.map((candidate) => path.resolve(candidate)),
  ];
  const seenRoots = new Set<string>();

  for (const root of candidates) {
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    const isDirectory = await fs
      .stat(root)
      .then((stats) => stats.isDirectory())
      .catch(() => false);
    if (isDirectory) return root;
  }

  return null;
}

export async function listSkillEntries(
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<SkillEntry[]> {
  const root = await resolveSkillsDir(moduleDir, additionalCandidates);
  if (!root) return [];

  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        source: path.join(root, entry.name),
      }));
  } catch {
    return [];
  }
}

export async function readSkillMarkdown(
  moduleDir: string,
  skillName: string,
): Promise<string | null> {
  const normalized = skillName.trim().toLowerCase();
  if (!normalized) return null;

  const entries = await listSkillEntries(moduleDir);
  const match = entries.find((entry) => entry.name === normalized);
  if (!match) return null;

  try {
    return await fs.readFile(path.join(match.source, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}

export async function ensureSkillSymlink(
  source: string,
  target: string,
  linkSkill: (
    source: string,
    target: string,
  ) => Promise<void> = (linkSource, linkTarget) =>
    fs.symlink(linkSource, linkTarget),
): Promise<"created" | "repaired" | "skipped"> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await linkSkill(source, target);
    return "created";
  }

  if (!existing.isSymbolicLink()) {
    return "skipped";
  }

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return "skipped";

  const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
  if (resolvedLinkedPath === source) {
    return "skipped";
  }

  const linkedPathExists = await fs
    .stat(resolvedLinkedPath)
    .then(() => true)
    .catch(() => false);
  if (linkedPathExists) {
    return "skipped";
  }

  await fs.unlink(target);
  await linkSkill(source, target);
  return "repaired";
}

export async function removeMaintainerOnlySkillSymlinks(
  skillsHome: string,
  allowedSkillNames: Iterable<string>,
): Promise<string[]> {
  const allowed = new Set(Array.from(allowedSkillNames));
  try {
    const entries = await fs.readdir(skillsHome, { withFileTypes: true });
    const removed: string[] = [];
    for (const entry of entries) {
      if (allowed.has(entry.name)) continue;

      const target = path.join(skillsHome, entry.name);
      const existing = await fs.lstat(target).catch(() => null);
      if (!existing?.isSymbolicLink()) continue;

      const linkedPath = await fs.readlink(target).catch(() => null);
      if (!linkedPath) continue;

      const resolvedLinkedPath = path.isAbsolute(linkedPath)
        ? linkedPath
        : path.resolve(path.dirname(target), linkedPath);
      if (
        !isMaintainerOnlySkillTarget(linkedPath) &&
        !isMaintainerOnlySkillTarget(resolvedLinkedPath)
      ) {
        continue;
      }

      await fs.unlink(target);
      removed.push(entry.name);
    }

    return removed;
  } catch {
    return [];
  }
}
