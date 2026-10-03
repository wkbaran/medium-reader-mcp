import { readFile } from "node:fs/promises";
import { DIGEST_FILES } from "../config.js";
import { parseProfile, type ReaderProfile } from "../classifier/types.js";
import { insideDir } from "./state.js";

/** interests.md: the "## Interests" and "## Skip" section bodies, trimmed. */
export type Interests = ReaderProfile;

/** Split interests.md into its `## Interests` and `## Skip` sections; a file with neither heading is all interests. */
export const parseInterests = (md: string): Interests => parseProfile(md);

export async function loadInterests(dir: string): Promise<Interests | null> {
  try {
    return parseInterests(await readFile(await insideDir(dir, DIGEST_FILES.interests), "utf8"));
  } catch {
    return null;
  }
}

