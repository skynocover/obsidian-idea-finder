/**
 * Path utilities for filtering and path manipulation.
 */

import type { FolderFilterSettings } from "../settings";

/**
 * Check if a file path should be filtered out based on folder filter settings.
 * Used by both IndexerService and FileWatcherService to consistently filter paths.
 *
 * @param filePath - The file path to check
 * @param folderFilter - The folder filter settings (include/exclude mode with folder list)
 * @returns true if the path should be filtered out (excluded from processing)
 */
export function shouldFilterPath(
	filePath: string,
	folderFilter: FolderFilterSettings
): boolean {
	if (folderFilter.folders.length === 0) {
		return false; // No filter configured
	}

	// Check if the file path matches any configured folder
	const matchesFilter = folderFilter.folders.some((folder) => {
		// Normalize paths for comparison
		const normalizedFolder = folder.replace(/\\/g, "/").replace(/^\/|\/$/g, "");
		const normalizedPath = filePath.replace(/\\/g, "/");

		// Check if the file is in this folder or a subfolder
		return (
			normalizedPath === normalizedFolder ||
			normalizedPath.startsWith(normalizedFolder + "/")
		);
	});

	if (folderFilter.mode === "exclude") {
		return matchesFilter; // Filter out if matches exclude list
	} else {
		return !matchesFilter; // Filter out if NOT in include list
	}
}
