/**
 * Path utilities for filtering and path manipulation.
 */

import type { FolderFilterSettings } from "../settings";

/**
 * Check if a file path should be filtered out based on folder filter settings.
 * Used by both IndexerService and FileWatcherService to consistently filter paths.
 * Only supports exclude mode - files matching configured folders will be excluded.
 *
 * @param filePath - The file path to check
 * @param folderFilter - The folder filter settings (folders to exclude)
 * @returns true if the path should be filtered out (excluded from processing)
 */
export function shouldFilterPath(
	filePath: string,
	folderFilter: FolderFilterSettings
): boolean {
	if (folderFilter.folders.length === 0) {
		return false; // No filter configured
	}

	const normalizedPath = filePath.replace(/\\/g, "/");

	// Check if the file path matches any configured folder to exclude
	return folderFilter.folders.some((folder) => {
		// Normalize folder path
		const normalizedFolder = folder.replace(/\\/g, "/").replace(/^\/|\/$/g, "");

		// Special case: root folder "/" or empty string matches files without any directory
		if (normalizedFolder === "") {
			// Root folder: match files that have no "/" in their path (direct children of vault root)
			return !normalizedPath.includes("/");
		}

		// Check if the file is in this folder or a subfolder
		return (
			normalizedPath === normalizedFolder ||
			normalizedPath.startsWith(normalizedFolder + "/")
		);
	});
}
