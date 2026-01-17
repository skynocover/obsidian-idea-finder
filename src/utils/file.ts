/**
 * File utilities for reading content from the Obsidian vault.
 */

import { TFile, type App } from "obsidian";

/**
 * Read file content from vault using cached read for performance.
 * Returns null if the file doesn't exist or is not a TFile.
 *
 * @param app - The Obsidian App instance
 * @param filePath - The path to the file to read
 * @returns The file content or null if not found
 */
export async function readFileContent(
	app: App,
	filePath: string
): Promise<string | null> {
	const file = app.vault.getAbstractFileByPath(filePath);
	if (file instanceof TFile) {
		return await app.vault.cachedRead(file);
	}
	return null;
}
