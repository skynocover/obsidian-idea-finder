/**
 * Vector utilities for embedding storage, similarity calculation, and hashing.
 */

// ===== Vector Storage =====

/**
 * Convert a vector (array of numbers) to a Uint8Array for SQLite BLOB storage.
 * Uses Float32Array for efficient storage (4 bytes per number).
 * Returns a view over the same buffer to avoid extra memory allocation.
 */
export function vectorToBlob(vector: number[]): Uint8Array {
	const float32 = new Float32Array(vector);
	return new Uint8Array(float32.buffer, float32.byteOffset, float32.byteLength);
}

/**
 * Convert a Uint8Array (from SQLite BLOB) back to a vector.
 * Handles potential byte offset from the source buffer.
 * Validates that the blob has a valid length for vector conversion.
 *
 * @throws Error if the blob length is not valid for Float32Array conversion
 */
export function blobToVector(blob: Uint8Array): number[] {
	if (blob.byteLength === 0) {
		return [];
	}

	if (blob.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
		throw new Error(
			`Invalid blob length for vector conversion: ${blob.byteLength} bytes ` +
			`(must be divisible by ${Float32Array.BYTES_PER_ELEMENT})`
		);
	}

	const float32 = new Float32Array(
		blob.buffer,
		blob.byteOffset,
		blob.byteLength / Float32Array.BYTES_PER_ELEMENT
	);
	return Array.from(float32);
}

// ===== Similarity Calculation =====

/**
 * Calculate cosine similarity between two vectors.
 * Returns a value between -1 and 1, where 1 means identical direction.
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
	if (vecA.length !== vecB.length) {
		throw new Error("Vectors must have the same length");
	}

	if (vecA.length === 0) {
		return 0;
	}

	let dotProduct = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < vecA.length; i++) {
		const a = vecA[i] ?? 0;
		const b = vecB[i] ?? 0;
		dotProduct += a * b;
		normA += a * a;
		normB += b * b;
	}

	const magnitude = Math.sqrt(normA) * Math.sqrt(normB);

	if (magnitude === 0) {
		return 0;
	}

	return dotProduct / magnitude;
}

/**
 * Convert similarity score (-1 to 1) to percentage (0 to 100).
 * Clamps negative values to 0.
 */
export function similarityToPercent(similarity: number): number {
	const clamped = Math.max(0, similarity);
	return Math.round(clamped * 100);
}

// ===== Hashing =====

/**
 * Calculate SHA-256 hash of content using Web Crypto API.
 * Works in both browser and Obsidian environment.
 */
export async function sha256(content: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(content);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ===== Async Utilities =====

/**
 * Sleep for a specified duration.
 * Use for delays, rate limiting, or yielding to the main thread.
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
