import { Notice } from "obsidian";

/**
 * Duration constants for different notice types (in milliseconds)
 */
const NOTICE_DURATION = {
	SUCCESS: 4000,
	ERROR: 6000,
	WARNING: 5000,
	INFO: 3500,
	PROGRESS: 3000,
} as const;

/**
 * Show a success notice
 */
export function showSuccess(message: string): Notice {
	return new Notice(message, NOTICE_DURATION.SUCCESS);
}

/**
 * Show an error notice (longer duration)
 */
export function showError(message: string): Notice {
	return new Notice(message, NOTICE_DURATION.ERROR);
}

/**
 * Show a warning notice
 */
export function showWarning(message: string): Notice {
	return new Notice(message, NOTICE_DURATION.WARNING);
}

/**
 * Show an info notice
 */
export function showInfo(message: string): Notice {
	return new Notice(message, NOTICE_DURATION.INFO);
}

/**
 * Show a progress notice (shorter duration)
 */
export function showProgress(message: string): Notice {
	return new Notice(message, NOTICE_DURATION.PROGRESS);
}
