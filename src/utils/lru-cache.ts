/**
 * A simple LRU (Least Recently Used) cache implementation.
 * Used for caching search results to improve performance.
 */
export class LRUCache<K, V> {
	private cache = new Map<K, V>();
	private readonly maxSize: number;

	constructor(maxSize: number = 20) {
		this.maxSize = maxSize;
	}

	/**
	 * Get a value from the cache.
	 * Moves the accessed item to the end (most recently used).
	 */
	get(key: K): V | undefined {
		if (!this.cache.has(key)) {
			return undefined;
		}

		// Move to end (most recently used)
		const value = this.cache.get(key)!;
		this.cache.delete(key);
		this.cache.set(key, value);
		return value;
	}

	/**
	 * Set a value in the cache.
	 * Evicts the least recently used item if at capacity.
	 */
	set(key: K, value: V): void {
		// If key exists, delete it first to update its position
		if (this.cache.has(key)) {
			this.cache.delete(key);
		}

		// Evict oldest if at capacity
		if (this.cache.size >= this.maxSize) {
			const oldestKey = this.cache.keys().next().value;
			if (oldestKey !== undefined) {
				this.cache.delete(oldestKey);
			}
		}

		this.cache.set(key, value);
	}

	/**
	 * Check if a key exists in the cache.
	 */
	has(key: K): boolean {
		return this.cache.has(key);
	}

	/**
	 * Delete a specific key from the cache.
	 */
	delete(key: K): boolean {
		return this.cache.delete(key);
	}

	/**
	 * Clear the entire cache.
	 */
	clear(): void {
		this.cache.clear();
	}

	/**
	 * Get the current size of the cache.
	 */
	get size(): number {
		return this.cache.size;
	}

	/**
	 * Invalidate all entries that match a predicate.
	 * Useful for invalidating cache when files change.
	 */
	invalidateMatching(predicate: (key: K, value: V) => boolean): number {
		let invalidated = 0;
		for (const [key, value] of this.cache.entries()) {
			if (predicate(key, value)) {
				this.cache.delete(key);
				invalidated++;
			}
		}
		return invalidated;
	}
}
