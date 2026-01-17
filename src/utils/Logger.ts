/**
 * Simple Logger using bind to preserve call site in DevTools.
 *
 * Benefits:
 * - Click on console output jumps to actual source location
 * - Simple implementation, easy to understand
 *
 * Trade-offs:
 * - Cannot dynamically control log levels at runtime
 * - Cannot add timestamps or other dynamic info
 */
export class Logger {
	// Bind console methods to preserve call site
	debug = console.debug.bind(console, "[DEBUG]");
	info = console.log.bind(console, "[INFO]");
	warn = console.warn.bind(console, "[WARN]");
	error = console.error.bind(console, "[ERROR]");

	// Performance tracking
	private timers = new Map<string, number>();

	/**
	 * Start a performance timer.
	 */
	startTimer(name: string): void {
		this.timers.set(name, performance.now());
	}

	/**
	 * End a performance timer and log the duration.
	 */
	endTimer(name: string): number | null {
		const start = this.timers.get(name);
		if (start === undefined) return null;

		const duration = performance.now() - start;
		this.timers.delete(name);
		this.debug(`${name}: ${duration.toFixed(2)}ms`);
		return duration;
	}

	/**
	 * Measure async function duration.
	 */
	async measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
		this.startTimer(name);
		try {
			return await fn();
		} finally {
			this.endTimer(name);
		}
	}
}
