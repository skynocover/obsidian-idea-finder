export interface Note {
	id: string;
	filePath: string;
	title: string;
	contentHash: string;
	indexedAt: number; // Unix timestamp
}

export interface Embedding {
	noteId: string;
	vector: number[];
	contentHash: string;
}

export interface NoteWithEmbedding {
	noteId: string;
	title: string;
	filePath: string;
	vector: number[];
}

export interface IndexerStats {
	totalNotes: number;
	totalEmbeddings: number;
	pendingEmbeddings: number;
	lastIndexedAt: number | null;
}

// Chunk types for Phase 3
export interface Chunk {
	id: string;
	noteId: string;
	heading: string | null;
	headingLevel: number | null; // 1 = #, 2 = ##, etc.
	content: string;
	startLine: number;
	contentHash: string;
}

export interface ChunkEmbedding {
	chunkId: string;
	vector: number[];
	contentHash: string;
}

export interface ChunkWithNote {
	chunkId: string;
	noteId: string;
	noteTitle: string;
	filePath: string;
	heading: string | null;
	headingLevel: number | null;
	content: string;
	startLine: number;
	vector: number[];
}
