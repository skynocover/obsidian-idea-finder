/**
 * Base error class for embedding-related errors
 */
export class EmbeddingError extends Error {
	constructor(
		message: string,
		public readonly code: string,
		public readonly retryable: boolean = false
	) {
		super(message);
		this.name = "EmbeddingError";
	}
}

/**
 * API rate limit exceeded (HTTP 429)
 */
export class RateLimitError extends EmbeddingError {
	constructor(
		public readonly retryAfterMs: number = 60000,
		message = "Rate limit exceeded"
	) {
		super(message, "RATE_LIMIT", true);
		this.name = "RateLimitError";
	}
}

/**
 * Invalid or expired API key (HTTP 401)
 */
export class AuthenticationError extends EmbeddingError {
	constructor(message = "Invalid API key") {
		super(message, "AUTH_ERROR", false);
		this.name = "AuthenticationError";
	}
}

/**
 * API quota exceeded (HTTP 402)
 */
export class QuotaExceededError extends EmbeddingError {
	constructor(message = "API quota exceeded") {
		super(message, "QUOTA_EXCEEDED", false);
		this.name = "QuotaExceededError";
	}
}

/**
 * API server error (HTTP 5xx)
 */
export class ServerError extends EmbeddingError {
	constructor(
		public readonly statusCode: number,
		message = "API server error"
	) {
		super(message, "SERVER_ERROR", true);
		this.name = "ServerError";
	}
}

/**
 * Network connectivity error
 */
export class NetworkError extends EmbeddingError {
	constructor(message = "Network error") {
		super(message, "NETWORK_ERROR", true);
		this.name = "NetworkError";
	}
}

/**
 * Request timeout
 */
export class TimeoutError extends EmbeddingError {
	constructor(message = "Request timeout") {
		super(message, "TIMEOUT", true);
		this.name = "TimeoutError";
	}
}

/**
 * API key not configured
 */
export class ConfigurationError extends EmbeddingError {
	constructor(message = "API key not configured") {
		super(message, "CONFIG_ERROR", false);
		this.name = "ConfigurationError";
	}
}

/**
 * Embedding generation already in progress
 */
export class ConcurrencyError extends EmbeddingError {
	constructor(message = "Embedding generation already in progress") {
		super(message, "CONCURRENCY_ERROR", false);
		this.name = "ConcurrencyError";
	}
}
