import {
	EmbeddingError,
	RateLimitError,
	AuthenticationError,
	QuotaExceededError,
	ServerError,
	NetworkError,
	TimeoutError,
	ConfigurationError,
	ConcurrencyError,
} from "../errors";
import { showError, showWarning, showInfo } from "../utils/notice";
import type { Logger } from "../utils/Logger";

/**
 * Error severity levels for logging and notification decisions.
 */
export type ErrorSeverity = "critical" | "error" | "warning" | "info";

/**
 * Error handling result with recommended action.
 */
export interface ErrorHandlingResult {
	severity: ErrorSeverity;
	userMessage: string;
	shouldNotify: boolean;
	shouldLog: boolean;
	retryable: boolean;
	retryDelayMs?: number;
}

/**
 * Centralized error handler for the plugin.
 * Provides consistent error logging, user notification, and recovery strategies.
 */
export class ErrorHandler {
	private static instance: ErrorHandler | null = null;
	private logger: Logger | null = null;

	/**
	 * Get the singleton instance.
	 */
	static getInstance(): ErrorHandler {
		if (!ErrorHandler.instance) {
			ErrorHandler.instance = new ErrorHandler();
		}
		return ErrorHandler.instance;
	}

	/**
	 * Set the logger instance.
	 */
	setLogger(logger: Logger): void {
		this.logger = logger;
	}

	/**
	 * Handle an error and return handling recommendations.
	 */
	handle(error: unknown, context?: string): ErrorHandlingResult {
		const result = this.analyzeError(error);

		// Log the error
		if (result.shouldLog) {
			this.logError(error, context, result.severity);
		}

		// Notify user
		if (result.shouldNotify) {
			this.notifyUser(result);
		}

		return result;
	}

	/**
	 * Handle an error silently (log only, no user notification).
	 */
	handleSilent(error: unknown, context?: string): ErrorHandlingResult {
		const result = this.analyzeError(error);

		// Log the error
		if (result.shouldLog) {
			this.logError(error, context, result.severity);
		}

		return result;
	}

	/**
	 * Analyze an error and determine handling strategy.
	 */
	private analyzeError(error: unknown): ErrorHandlingResult {
		// Handle EmbeddingError and its subclasses
		if (error instanceof EmbeddingError) {
			return this.handleEmbeddingError(error);
		}

		// Handle standard Error
		if (error instanceof Error) {
			return this.handleStandardError(error);
		}

		// Handle unknown errors
		return {
			severity: "error",
			userMessage: "An unexpected error occurred",
			shouldNotify: true,
			shouldLog: true,
			retryable: false,
		};
	}

	/**
	 * Handle EmbeddingError and its subclasses.
	 */
	private handleEmbeddingError(error: EmbeddingError): ErrorHandlingResult {
		// Rate limit errors
		if (error instanceof RateLimitError) {
			return {
				severity: "warning",
				userMessage: "Rate limit reached. Please wait before retrying.",
				shouldNotify: true,
				shouldLog: true,
				retryable: true,
				retryDelayMs: error.retryAfterMs,
			};
		}

		// Authentication errors
		if (error instanceof AuthenticationError) {
			return {
				severity: "critical",
				userMessage: "Invalid API key. Please check your settings.",
				shouldNotify: true,
				shouldLog: true,
				retryable: false,
			};
		}

		// Quota exceeded errors
		if (error instanceof QuotaExceededError) {
			return {
				severity: "critical",
				userMessage: "API quota exceeded. Please check your billing.",
				shouldNotify: true,
				shouldLog: true,
				retryable: false,
			};
		}

		// Server errors
		if (error instanceof ServerError) {
			return {
				severity: "error",
				userMessage: "API server is temporarily unavailable. Please try again later.",
				shouldNotify: true,
				shouldLog: true,
				retryable: true,
				retryDelayMs: 5000,
			};
		}

		// Network errors
		if (error instanceof NetworkError) {
			return {
				severity: "warning",
				userMessage: "Network error. Please check your connection.",
				shouldNotify: true,
				shouldLog: true,
				retryable: true,
				retryDelayMs: 2000,
			};
		}

		// Timeout errors
		if (error instanceof TimeoutError) {
			return {
				severity: "warning",
				userMessage: "Request timed out. Please try again.",
				shouldNotify: true,
				shouldLog: true,
				retryable: true,
				retryDelayMs: 1000,
			};
		}

		// Configuration errors
		if (error instanceof ConfigurationError) {
			return {
				severity: "warning",
				userMessage: error.message || "Please configure your API key in settings.",
				shouldNotify: true,
				shouldLog: false, // Configuration issues are expected
				retryable: false,
			};
		}

		// Concurrency errors
		if (error instanceof ConcurrencyError) {
			return {
				severity: "info",
				userMessage: "Operation already in progress. Please wait.",
				shouldNotify: true,
				shouldLog: false, // Concurrency issues are expected
				retryable: false,
			};
		}

		// Generic EmbeddingError
		return {
			severity: "error",
			userMessage: error.message || "An error occurred during embedding generation.",
			shouldNotify: true,
			shouldLog: true,
			retryable: error.retryable,
		};
	}

	/**
	 * Handle standard Error instances.
	 */
	private handleStandardError(error: Error): ErrorHandlingResult {
		const message = error.message.toLowerCase();

		// Check for database-related errors
		if (message.includes("database") || message.includes("sqlite") || message.includes("sql")) {
			return {
				severity: "critical",
				userMessage: "Database error. Try reloading the plugin.",
				shouldNotify: true,
				shouldLog: true,
				retryable: false,
			};
		}

		// Check for file system errors
		if (message.includes("file") || message.includes("permission") || message.includes("enoent")) {
			return {
				severity: "error",
				userMessage: "File system error. Please check file permissions.",
				shouldNotify: true,
				shouldLog: true,
				retryable: false,
			};
		}

		// Default handling
		return {
			severity: "error",
			userMessage: error.message || "An unexpected error occurred.",
			shouldNotify: true,
			shouldLog: true,
			retryable: false,
		};
	}

	/**
	 * Log an error using the Logger service.
	 */
	private logError(error: unknown, context: string | undefined, severity: ErrorSeverity): void {
		const prefix = context ? `[${context}]` : "[Idea Finder]";

		switch (severity) {
			case "critical":
			case "error":
				this.logger?.error(`${prefix} Error:`, error);
				break;
			case "warning":
				this.logger?.warn(`${prefix} Warning:`, error);
				break;
			case "info":
				this.logger?.info(`${prefix} Info:`, error);
				break;
		}
	}

	/**
	 * Notify the user about an error.
	 */
	private notifyUser(result: ErrorHandlingResult): void {
		switch (result.severity) {
			case "critical":
			case "error":
				showError(result.userMessage);
				break;
			case "warning":
				showWarning(result.userMessage);
				break;
			case "info":
				showInfo(result.userMessage);
				break;
		}
	}

	/**
	 * Check if an error is retryable.
	 */
	isRetryable(error: unknown): boolean {
		if (error instanceof EmbeddingError) {
			return error.retryable;
		}
		return false;
	}

	/**
	 * Get retry delay for an error (in milliseconds).
	 */
	getRetryDelay(error: unknown): number {
		if (error instanceof RateLimitError) {
			return error.retryAfterMs;
		}
		if (error instanceof ServerError) {
			return 5000;
		}
		if (error instanceof NetworkError || error instanceof TimeoutError) {
			return 2000;
		}
		return 1000;
	}
}

// Export singleton instance
export const errorHandler = ErrorHandler.getInstance();
